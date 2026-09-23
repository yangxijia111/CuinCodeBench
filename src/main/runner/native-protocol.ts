/**
 * Node ↔ ccb-launcher 帧协议（docs/V1_3_JOB_OBJECT_DESIGN.md §3）。
 * 帧 = [u8 type][u32 LE len][payload]；常量与 native/ccb-launcher/launcher.cpp 双端同值
 * （launcher --selftest 与本文件单测交叉验证）。
 * 仅做纯编解码（可独立单测）；进程 IO 在 native-launcher.ts。
 */

export const FRAME_REQ = 0x01
export const FRAME_STDIN = 0x02
export const FRAME_STDIN_EOF = 0x03
export const FRAME_STDOUT = 0x10
export const FRAME_STDERR = 0x11
export const FRAME_INFO = 0x20
export const FRAME_RESULT = 0x21
export const FRAME_ERROR = 0x22

/** 数据帧 payload 上限（与 launcher 一致） */
export const MAX_DATA_PAYLOAD = 256 * 1024
/** JSON 帧（REQ/INFO/RESULT/ERROR）payload 上限 */
export const MAX_JSON_PAYLOAD = 16 * 1024

export const HEADER_SIZE = 5

/** 协议版本（REQ.version；双端同值，破坏性变更 +1） */
export const PROTOCOL_VERSION = 1

/** 编码一帧（payload 长度必须已在调用方约束） */
export function encodeFrame(type: number, payload: Buffer): Buffer {
  if (payload.length > MAX_DATA_PAYLOAD) {
    throw new Error(`帧 payload 超限：${payload.length} > ${MAX_DATA_PAYLOAD}`)
  }
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length)
  frame[0] = type
  frame.writeUInt32LE(payload.length, 1)
  payload.copy(frame, HEADER_SIZE)
  return frame
}

export interface Frame {
  type: number
  payload: Buffer
}

/**
 * 增量帧解码器：feed 任意分块字节，产出完整帧。
 * 超限/EOF 中断 = 协议损坏（抛 ProtocolError），由上层转换为 launcher_died/protocol_error。
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private expectedLen: number | null = null
  private currentType = 0

  /** 喂入字节；返回本次凑齐的全部帧 */
  feed(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    for (;;) {
      if (this.expectedLen === null) {
        if (this.buffer.length < HEADER_SIZE) return frames
        this.currentType = this.buffer[0] ?? 0
        this.expectedLen = this.buffer.readUInt32LE(1)
        this.buffer = this.buffer.subarray(HEADER_SIZE)
        if (this.expectedLen > MAX_DATA_PAYLOAD) {
          throw new ProtocolError(`帧长超限：${this.expectedLen}`)
        }
      }
      if (this.buffer.length < this.expectedLen) return frames
      const payload = this.buffer.subarray(0, this.expectedLen)
      this.buffer = this.buffer.subarray(this.expectedLen)
      frames.push({ type: this.currentType, payload: Buffer.from(payload) })
      this.expectedLen = null
    }
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}
