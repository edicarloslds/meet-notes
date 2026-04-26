import AVFoundation
import Foundation
import Speech

struct HelperCommand: Decodable {
  let type: String
  let locale: String?
  let sampleRate: Double?
  let requiresOnDevice: Bool?
  let contextualStrings: [String]?
  let pcm: String?
}

final class JsonEmitter {
  private let queue = DispatchQueue(label: "distill.apple-speech-helper.output")

  func emit(_ object: [String: Any]) {
    queue.async {
      guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: []),
        let line = String(data: data, encoding: .utf8)
      else { return }
      FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
  }
}

final class SpeechSession: NSObject, SFSpeechRecognizerDelegate {
  private let emitter: JsonEmitter
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var audioFormat: AVAudioFormat?
  private var finishRequested = false
  private var doneEmitted = false

  init(emitter: JsonEmitter) {
    self.emitter = emitter
  }

  func start(
    localeIdentifier: String,
    sampleRate: Double,
    requiresOnDevice: Bool,
    contextualStrings: [String]
  ) {
    SFSpeechRecognizer.requestAuthorization { [weak self] status in
      guard let self else { return }
      guard status == .authorized else {
        self.emitError("Permissão de reconhecimento de fala negada pelo macOS.")
        return
      }

      let locale = Locale(identifier: localeIdentifier)
      guard let recognizer = SFSpeechRecognizer(locale: locale) else {
        self.emitError("Apple Speech não suporta o idioma \(localeIdentifier).")
        return
      }

      if requiresOnDevice && !recognizer.supportsOnDeviceRecognition {
        self.emitError("Reconhecimento no dispositivo indisponível para \(localeIdentifier) neste Mac.")
        return
      }

      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false
      )
      guard let format else {
        self.emitError("Formato de áudio inválido para Apple Speech.")
        return
      }

      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      request.requiresOnDeviceRecognition = requiresOnDevice
      request.contextualStrings = contextualStrings
      if #available(macOS 13.0, *) {
        request.addsPunctuation = true
      }

      self.recognizer = recognizer
      self.recognizer?.delegate = self
      self.request = request
      self.audioFormat = format
      self.finishRequested = false
      self.doneEmitted = false

      self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
        guard let self else { return }
        if let result {
          self.emitter.emit([
            "type": "result",
            "text": result.bestTranscription.formattedString,
            "isFinal": result.isFinal
          ])
          if result.isFinal {
            self.emitDone()
          }
        }

        if let error {
          if self.finishRequested {
            self.emitDone()
          } else {
            self.emitError(error.localizedDescription)
          }
        }
      }

      self.emitter.emit([
        "type": "ready",
        "supportsOnDevice": recognizer.supportsOnDeviceRecognition
      ])
    }
  }

  func appendBase64Pcm(_ encoded: String, sampleRate: Double?) {
    guard let request, !finishRequested else { return }
    guard let data = Data(base64Encoded: encoded), !data.isEmpty else { return }

    if let sampleRate, sampleRate > 0, sampleRate != audioFormat?.sampleRate {
      audioFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false
      )
    }

    guard let audioFormat else {
      emitError("Formato de áudio não inicializado.")
      return
    }

    let frameCount = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: frameCount) else {
      emitError("Não foi possível criar buffer de áudio.")
      return
    }
    buffer.frameLength = frameCount

    data.withUnsafeBytes { rawBuffer in
      guard
        let src = rawBuffer.bindMemory(to: Int16.self).baseAddress,
        let dst = buffer.int16ChannelData?.pointee
      else { return }
      dst.update(from: src, count: Int(frameCount))
    }

    request.append(buffer)
  }

  func finish() {
    finishRequested = true
    request?.endAudio()
    if task == nil {
      emitDone()
    }
  }

  func cancel() {
    finishRequested = true
    task?.cancel()
    request?.endAudio()
    emitDone()
  }

  func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
    if !available && !finishRequested {
      emitError("Apple Speech ficou indisponível.")
    }
  }

  private func emitError(_ message: String) {
    emitter.emit(["type": "error", "message": message])
  }

  private func emitDone() {
    guard !doneEmitted else { return }
    doneEmitted = true
    emitter.emit(["type": "done"])
  }
}

let emitter = JsonEmitter()
let session = SpeechSession(emitter: emitter)

func handle(_ command: HelperCommand) {
  switch command.type {
  case "start":
    session.start(
      localeIdentifier: command.locale ?? "pt-BR",
      sampleRate: command.sampleRate ?? 16_000,
      requiresOnDevice: command.requiresOnDevice ?? true,
      contextualStrings: command.contextualStrings ?? []
    )
  case "audio":
    if let pcm = command.pcm {
      session.appendBase64Pcm(pcm, sampleRate: command.sampleRate)
    }
  case "finish":
    session.finish()
  case "cancel":
    session.cancel()
    exit(0)
  default:
    emitter.emit(["type": "error", "message": "Comando desconhecido: \(command.type)"])
  }
}

DispatchQueue.global(qos: .userInitiated).async {
  let decoder = JSONDecoder()
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8) else { continue }
    do {
      let command = try decoder.decode(HelperCommand.self, from: data)
      handle(command)
    } catch {
      emitter.emit(["type": "error", "message": "JSON inválido: \(error.localizedDescription)"])
    }
  }
  session.cancel()
  exit(0)
}

RunLoop.main.run()
