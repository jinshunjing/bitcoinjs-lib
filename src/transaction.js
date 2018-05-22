const Buffer = require('safe-buffer').Buffer
const bcrypto = require('./crypto')
const bscript = require('./script')
const bufferutils = require('./bufferutils')
const opcodes = require('bitcoin-ops')
const typeforce = require('typeforce')
const types = require('./types')
const varuint = require('varuint-bitcoin')

const EMPTY_SCRIPT = Buffer.allocUnsafe(0)
const EMPTY_WITNESS = []
const ZERO = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
const ONE = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const VALUE_UINT64_MAX = Buffer.from('ffffffffffffffff', 'hex')
const BLANK_OUTPUT = {
  script: EMPTY_SCRIPT,
  valueBuffer: VALUE_UINT64_MAX
}

const varSliceSize = (someScript) => {
  const length = someScript.length

  return varuint.encodingLength(length) + length
}

const vectorSize = (someVector) => {
  const length = someVector.length

  return varuint.encodingLength(length) + someVector.reduce((sum, witness) =>
    sum + varSliceSize(witness)
  , 0)
}

class Transaction {
  constructor () {
    this.version = 1
    this.locktime = 0
    this.ins = []
    this.outs = []
  }

  static get DEFAULT_SEQUENCE () { return 0xffffffff }
  static get SIGHASH_ALL () { return 0x01 }
  static get SIGHASH_NONE () { return 0x02 }
  static get SIGHASH_SINGLE () { return 0x03 }
  static get SIGHASH_ANYONECANPAY () { return 0x80 }
  static get ADVANCED_TRANSACTION_MARKER () { return 0x00 }
  static get ADVANCED_TRANSACTION_FLAG () { return 0x01 }

  get isCoinbase () {
    return this.ins.length === 1 && Transaction.isCoinbaseHash(this.ins[0].hash)
  }

  get hasWitnesses () {
    return this.ins.some((x) =>
      x.witness.length !== 0
    )
  }

  get weight () {
    const base = this.__byteLength(false)
    const total = this.__byteLength(true)
    return base * 3 + total
  }

  get virtualSize () {
    return Math.ceil(this.weight / 4)
  }

  get byteLength () {
    return this.__byteLength(true)
  }

  get hash () {
    return bcrypto.hash256(this.__toBuffer(undefined, undefined, false))
  }

  get id () {
    // transaction hash's are displayed in reverse order
    return this.hash.reverse().toString('hex')
  }

  get buffer () {
    return this.__toBuffer(undefined, undefined, true)
  }

  get hex () {
    return this.buffer.toString('hex')
  }

  addInput (hash, index, sequence, scriptSig) {
    typeforce(types.tuple(
      types.Hash256bit,
      types.UInt32,
      types.maybe(types.UInt32),
      types.maybe(types.Buffer)
    ), arguments)

    if (types.Null(sequence)) {
      sequence = Transaction.DEFAULT_SEQUENCE
    }

    // Add the input and return the input's index
    return (this.ins.push({
      hash: hash,
      index: index,
      script: scriptSig || EMPTY_SCRIPT,
      sequence: sequence,
      witness: EMPTY_WITNESS
    }) - 1)
  }

  addOutput (scriptPubKey, value) {
    typeforce(types.tuple(types.Buffer, types.Satoshi), arguments)

    // Add the output and return the output's index
    return (this.outs.push({
      script: scriptPubKey,
      value: value
    }) - 1)
  }

  __byteLength (__allowWitness) {
    const hasWitnesses = __allowWitness && this.hasWitnesses

    return (
      (hasWitnesses ? 10 : 8) +
      varuint.encodingLength(this.ins.length) +
      varuint.encodingLength(this.outs.length) +
      this.ins.reduce((sum, input) => sum + 40 + varSliceSize(input.script), 0) +
      this.outs.reduce((sum, output) => sum + 8 + varSliceSize(output.script), 0) +
      (hasWitnesses ? this.ins.reduce((sum, input) => sum + vectorSize(input.witness), 0) : 0)
    )
  }

  clone () {
    const newTx = new Transaction()
    newTx.version = this.version
    newTx.locktime = this.locktime

    newTx.ins = this.ins.map((txIn) =>
      ({
        hash: txIn.hash,
        index: txIn.index,
        script: txIn.script,
        sequence: txIn.sequence,
        witness: txIn.witness
      })
    )

    newTx.outs = this.outs.map((txOut) =>
      ({
        script: txOut.script,
        value: txOut.value
      })
    )

    return newTx
  }

  /**
   * Hash transaction for signing a specific input.
   *
   * Bitcoin uses a different hash for each signed transaction input.
   * This method copies the transaction, makes the necessary changes based on the
   * hashType, and then hashes the result.
   * This hash can then be used to sign the provided transaction input.
   */
  hashForSignature (inIndex, prevOutScript, hashType) {
    typeforce(types.tuple(types.UInt32, types.Buffer, /* types.UInt8 */ types.Number), arguments)

    // https://github.com/bitcoin/bitcoin/blob/master/src/test/sighash_tests.cpp#L29
    if (inIndex >= this.ins.length) return ONE

    // ignore OP_CODESEPARATOR
    const ourScript = bscript.compile(bscript.decompile(prevOutScript).filter((x) =>
      x !== opcodes.OP_CODESEPARATOR
    ))

    const txTmp = this.clone()

    // SIGHASH_NONE: ignore all outputs? (wildcard payee)
    if ((hashType & 0x1f) === Transaction.SIGHASH_NONE) {
      txTmp.outs = []

      // ignore sequence numbers (except at inIndex)
      txTmp.ins.forEach((input, i) => {
        if (i === inIndex) return

        input.sequence = 0
      })

    // SIGHASH_SINGLE: ignore all outputs, except at the same index?
    } else if ((hashType & 0x1f) === Transaction.SIGHASH_SINGLE) {
      // https://github.com/bitcoin/bitcoin/blob/master/src/test/sighash_tests.cpp#L60
      if (inIndex >= this.outs.length) return ONE

      // truncate outputs after
      txTmp.outs.length = inIndex + 1

      // "blank" outputs before
      for (let i = 0; i < inIndex; i++) {
        txTmp.outs[i] = BLANK_OUTPUT
      }

      // ignore sequence numbers (except at inIndex)
      txTmp.ins.forEach((input, y) => {
        if (y === inIndex) return

        input.sequence = 0
      })
    }

    // SIGHASH_ANYONECANPAY: ignore inputs entirely?
    if (hashType & Transaction.SIGHASH_ANYONECANPAY) {
      txTmp.ins = [txTmp.ins[inIndex]]
      txTmp.ins[0].script = ourScript

    // SIGHASH_ALL: only ignore input scripts
    } else {
      // "blank" others input scripts
      txTmp.ins.forEach((input) => { input.script = EMPTY_SCRIPT })
      txTmp.ins[inIndex].script = ourScript
    }

    // serialize and hash
    const buffer = Buffer.allocUnsafe(txTmp.__byteLength(false) + 4)
    buffer.writeInt32LE(hashType, buffer.length - 4)
    txTmp.__toBuffer(buffer, 0, false)

    return bcrypto.hash256(buffer)
  }

  hashForWitnessV0 (inIndex, prevOutScript, value, hashType) {
    typeforce(types.tuple(types.UInt32, types.Buffer, types.Satoshi, types.UInt32), arguments)

    let tbuffer, toffset
    const writeSlice = (slice) => { toffset += slice.copy(tbuffer, toffset) }
    const writeUInt32 = (i) => { toffset = tbuffer.writeUInt32LE(i, toffset) }
    const writeUInt64 = (i) => { toffset = bufferutils.writeUInt64LE(tbuffer, i, toffset) }
    const writeVarInt = (i) => {
      varuint.encode(i, tbuffer, toffset)
      toffset += varuint.encode.bytes
    }
    const writeVarSlice = (slice) => { writeVarInt(slice.length); writeSlice(slice) }

    let hashOutputs = ZERO
    let hashPrevouts = ZERO
    let hashSequence = ZERO

    if (!(hashType & Transaction.SIGHASH_ANYONECANPAY)) {
      tbuffer = Buffer.allocUnsafe(36 * this.ins.length)
      toffset = 0

      this.ins.forEach((txIn) => {
        writeSlice(txIn.hash)
        writeUInt32(txIn.index)
      })

      hashPrevouts = bcrypto.hash256(tbuffer)
    }

    if (!(hashType & Transaction.SIGHASH_ANYONECANPAY) &&
         (hashType & 0x1f) !== Transaction.SIGHASH_SINGLE &&
         (hashType & 0x1f) !== Transaction.SIGHASH_NONE) {
      tbuffer = Buffer.allocUnsafe(4 * this.ins.length)
      toffset = 0

      this.ins.forEach((txIn) => {
        writeUInt32(txIn.sequence)
      })

      hashSequence = bcrypto.hash256(tbuffer)
    }

    if ((hashType & 0x1f) !== Transaction.SIGHASH_SINGLE &&
        (hashType & 0x1f) !== Transaction.SIGHASH_NONE) {
      const txOutsSize = this.outs.reduce((sum, output) =>
        sum + 8 + varSliceSize(output.script)
      , 0)

      tbuffer = Buffer.allocUnsafe(txOutsSize)
      toffset = 0

      this.outs.forEach((out) => {
        writeUInt64(out.value)
        writeVarSlice(out.script)
      })

      hashOutputs = bcrypto.hash256(tbuffer)
    } else if ((hashType & 0x1f) === Transaction.SIGHASH_SINGLE && inIndex < this.outs.length) {
      const output = this.outs[inIndex]

      tbuffer = Buffer.allocUnsafe(8 + varSliceSize(output.script))
      toffset = 0
      writeUInt64(output.value)
      writeVarSlice(output.script)

      hashOutputs = bcrypto.hash256(tbuffer)
    }

    tbuffer = Buffer.allocUnsafe(156 + varSliceSize(prevOutScript))
    toffset = 0

    const input = this.ins[inIndex]
    writeUInt32(this.version)
    writeSlice(hashPrevouts)
    writeSlice(hashSequence)
    writeSlice(input.hash)
    writeUInt32(input.index)
    writeVarSlice(prevOutScript)
    writeUInt64(value)
    writeUInt32(input.sequence)
    writeSlice(hashOutputs)
    writeUInt32(this.locktime)
    writeUInt32(hashType)
    return bcrypto.hash256(tbuffer)
  }

  toBuffer (buffer, initialOffset) {
    return this.__toBuffer(buffer, initialOffset, true)
  }

  __toBuffer (buffer, initialOffset, __allowWitness) {
    if (!buffer) buffer = Buffer.allocUnsafe(this.__byteLength(__allowWitness))

    let offset = initialOffset || 0
    const writeSlice = (slice) => { offset += slice.copy(buffer, offset) }
    const writeUInt8 = (i) => { offset = buffer.writeUInt8(i, offset) }
    const writeUInt32 = (i) => { offset = buffer.writeUInt32LE(i, offset) }
    const writeInt32 = (i) => { offset = buffer.writeInt32LE(i, offset) }
    const writeUInt64 = (i) => { offset = bufferutils.writeUInt64LE(buffer, i, offset) }
    const writeVarInt = (i) => {
      varuint.encode(i, buffer, offset)
      offset += varuint.encode.bytes
    }
    const writeVarSlice = (slice) => { writeVarInt(slice.length); writeSlice(slice) }
    const writeVector = (vector) => { writeVarInt(vector.length); vector.forEach(writeVarSlice) }

    writeInt32(this.version)

    const hasWitnesses = __allowWitness && this.hasWitnesses

    if (hasWitnesses) {
      writeUInt8(Transaction.ADVANCED_TRANSACTION_MARKER)
      writeUInt8(Transaction.ADVANCED_TRANSACTION_FLAG)
    }

    writeVarInt(this.ins.length)

    this.ins.forEach((txIn) => {
      writeSlice(txIn.hash)
      writeUInt32(txIn.index)
      writeVarSlice(txIn.script)
      writeUInt32(txIn.sequence)
    })

    writeVarInt(this.outs.length)
    this.outs.forEach((txOut) => {
      if (!txOut.valueBuffer) {
        writeUInt64(txOut.value)
      } else {
        writeSlice(txOut.valueBuffer)
      }

      writeVarSlice(txOut.script)
    })

    if (hasWitnesses) {
      this.ins.forEach((input) => {
        writeVector(input.witness)
      })
    }

    writeUInt32(this.locktime)

    // avoid slicing unless necessary
    if (initialOffset !== undefined) return buffer.slice(initialOffset, offset)
    return buffer
  }

  setInputScript (index, scriptSig) {
    typeforce(types.tuple(types.Number, types.Buffer), arguments)

    this.ins[index].script = scriptSig
  }

  setWitness (index, witness) {
    typeforce(types.tuple(types.Number, [types.Buffer]), arguments)

    this.ins[index].witness = witness
  }
}

Transaction.fromBuffer = (buffer, __noStrict) => {
  let offset = 0
  const readSlice = (n) => {
    offset += n
    return buffer.slice(offset - n, offset)
  }

  const readUInt32 = () => {
    const i = buffer.readUInt32LE(offset)
    offset += 4
    return i
  }

  const readInt32 = () => {
    const i = buffer.readInt32LE(offset)
    offset += 4
    return i
  }

  const readUInt64 = () => {
    const i = bufferutils.readUInt64LE(buffer, offset)
    offset += 8
    return i
  }

  const readVarInt = () => {
    const vi = varuint.decode(buffer, offset)
    offset += varuint.decode.bytes
    return vi
  }

  const readVarSlice = () => {
    return readSlice(readVarInt())
  }

  const readVector = () => {
    const count = readVarInt()
    const vector = []
    for (let i = 0; i < count; i++) vector.push(readVarSlice())
    return vector
  }

  const tx = new Transaction()
  tx.version = readInt32()

  const marker = buffer.readUInt8(offset)
  const flag = buffer.readUInt8(offset + 1)

  let hasWitnesses = false
  if (marker === Transaction.ADVANCED_TRANSACTION_MARKER &&
      flag === Transaction.ADVANCED_TRANSACTION_FLAG) {
    offset += 2
    hasWitnesses = true
  }

  const vinLen = readVarInt()
  for (let i = 0; i < vinLen; ++i) {
    tx.ins.push({
      hash: readSlice(32),
      index: readUInt32(),
      script: readVarSlice(),
      sequence: readUInt32(),
      witness: EMPTY_WITNESS
    })
  }

  const voutLen = readVarInt()
  for (let i = 0; i < voutLen; ++i) {
    tx.outs.push({
      value: readUInt64(),
      script: readVarSlice()
    })
  }

  if (hasWitnesses) {
    for (let i = 0; i < vinLen; ++i) {
      tx.ins[i].witness = readVector()
    }

    // was this pointless?
    if (!tx.hasWitnesses) throw new Error('Transaction has superfluous witness data')
  }

  tx.locktime = readUInt32()

  if (__noStrict) return tx
  if (offset !== buffer.length) throw new Error('Transaction has unexpected data')

  return tx
}

Transaction.fromHex = (hex) => {
  return Transaction.fromBuffer(Buffer.from(hex, 'hex'))
}

Transaction.isCoinbaseHash = (buffer) => {
  typeforce(types.Hash256bit, buffer)
  for (let i = 0; i < 32; ++i) {
    if (buffer[i] !== 0) return false
  }
  return true
}

module.exports = Transaction
