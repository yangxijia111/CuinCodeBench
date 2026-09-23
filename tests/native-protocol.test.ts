import { describe, expect, it } from 'vitest'
import {
  FRAME_ERROR,
  FRAME_REQ,
  FRAME_RESULT,
  FRAME_STDIN,
  FRAME_STDIN_EOF,
  FRAME_STDOUT,
  MAX_DATA_PAYLOAD,
  FrameDecoder,
  ProtocolError,
  encodeFrame
} from '../src/main/runner/native-protocol'

/**
 * 帧协议编解码单元测试（跨平台，无 launcher 依赖）。
 * 常量值与 native/ccb-launcher/launcher.cpp 双端同值——值漂移由 launcher 集成测试兜底。
 */

describe('native-protocol 帧编解码', () => {
  it('编码：[u8 type][u32 LE][payload]', () => {
    const f = encodeFrame(FRAME_STDOUT, Buffer.from('hi'))
    expect(f[0]).toBe(0x10)
    expect(f.readUInt32LE(1)).toBe(2)
    expect(f.subarray(5).toString()).toBe('hi')
    expect(f.length).toBe(7)
  })

  it('空 payload 帧可编码（STDIN_EOF）', () => {
    const f = encodeFrame(FRAME_STDIN_EOF, Buffer.alloc(0))
    expect(f.length).toBe(5)
    expect(f.readUInt32LE(1)).toBe(0)
  })

  it('编码超限拒绝', () => {
    expect(() => encodeFrame(FRAME_STDIN, Buffer.alloc(MAX_DATA_PAYLOAD + 1))).toThrow(/超限/)
  })

  it('解码：单帧完整输入', () => {
    const d = new FrameDecoder()
    const frames = d.feed(encodeFrame(FRAME_REQ, Buffer.from('{"version":1}')))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.type).toBe(FRAME_REQ)
    expect(frames[0]?.payload.toString()).toBe('{"version":1}')
  })

  it('解码：任意字节分块（逐字节喂入）', () => {
    const d = new FrameDecoder()
    const raw = Buffer.concat([
      encodeFrame(FRAME_STDOUT, Buffer.from('abc')),
      encodeFrame(FRAME_ERROR, Buffer.from('e'))
    ])
    const collected: number[] = []
    for (const byte of raw) {
      for (const f of d.feed(Buffer.from([byte]))) collected.push(f.type)
    }
    expect(collected).toEqual([FRAME_STDOUT, FRAME_ERROR])
  })

  it('解码：跨块边界的 header/payload', () => {
    const d = new FrameDecoder()
    const raw = encodeFrame(FRAME_RESULT, Buffer.from('0123456789'))
    expect(d.feed(raw.subarray(0, 3))).toHaveLength(0)
    expect(d.feed(raw.subarray(3, 5))).toHaveLength(0)
    expect(d.feed(raw.subarray(5, 8))).toHaveLength(0)
    const frames = d.feed(raw.subarray(8))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.payload.toString()).toBe('0123456789')
  })

  it('解码：帧长超限抛 ProtocolError', () => {
    const d = new FrameDecoder()
    const bad = Buffer.alloc(5)
    bad[0] = FRAME_STDIN
    bad.writeUInt32LE(MAX_DATA_PAYLOAD + 1, 1)
    expect(() => d.feed(bad)).toThrow(ProtocolError)
  })

  it('解码：多帧混合流（stdout/stderr 交替）', () => {
    const d = new FrameDecoder()
    const raw = Buffer.concat([
      encodeFrame(FRAME_STDOUT, Buffer.from('out1')),
      encodeFrame(0x11, Buffer.from('err1')),
      encodeFrame(FRAME_STDOUT, Buffer.from('out2')),
      encodeFrame(FRAME_STDIN_EOF, Buffer.alloc(0))
    ])
    const frames = d.feed(raw)
    expect(frames.map((f) => f.type)).toEqual([FRAME_STDOUT, 0x11, FRAME_STDOUT, FRAME_STDIN_EOF])
    expect(frames.map((f) => f.payload.toString())).toEqual(['out1', 'err1', 'out2', ''])
  })
})
