class PcmCollector extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const ch = input[0]
    const copy = new Float32Array(ch.length)
    copy.set(ch)
    this.port.postMessage(copy, [copy.buffer])
    return true
  }
}

registerProcessor('pcm-collector', PcmCollector)
