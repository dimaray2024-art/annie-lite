/**
 * 密钥存储。
 *
 * 用 Electron 的 safeStorage 加密（macOS 下由钥匙串托底），密文落在 app 私有目录。
 * 一条重要语义：**解密失败时保留密文、不迁移、不删除**——密钥解不开通常是换了机器或钥匙串变了，
 * 这时候应该告诉用户「重新录入」，而不是把他的东西悄悄抹掉。
 */

import { safeStorage } from 'electron'
import path from 'node:path'
import { atomicWriteJson, readJson } from './store'

interface SecretsFile {
  doubao?: string
  vidu?: string
  rtcAppKey?: string
}

export type DoubaoKeyStatus = 'missing' | 'unavailable' | 'unreadable' | 'verified'

export class SecretStore {
  private readonly file: string
  private cache: SecretsFile
  private lastSaved = ''

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'secrets.json')
    this.cache = readJson<SecretsFile>(this.file, {})
  }

  private encrypt(value: string): string | undefined {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(payload: string): string | undefined {
    try {
      return safeStorage.decryptString(Buffer.from(payload, 'base64'))
    } catch {
      // 解密失败：保留原密文，让上层提示用户重新录入
      return undefined
    }
  }

  saveDoubaoKey(key: string): void {
    const encrypted = this.encrypt(key)
    if (!encrypted) throw new Error('系统加密不可用，无法安全保存密钥')
    this.cache = { ...this.cache, doubao: encrypted }
    this.lastSaved = key
    atomicWriteJson(this.file, this.cache)
  }

  clearDoubaoKey(): void {
    const next = { ...this.cache }
    delete next.doubao
    this.cache = next
    this.lastSaved = ''
    atomicWriteJson(this.file, next)
  }

  saveViduKey(key: string): void {
    const encrypted = this.encrypt(key)
    if (!encrypted) throw new Error('系统加密不可用，无法安全保存 Vidu 密钥')
    this.cache = { ...this.cache, vidu: encrypted }
    atomicWriteJson(this.file, this.cache)
  }

  clearViduKey(): void {
    const next = { ...this.cache }
    delete next.vidu
    this.cache = next
    atomicWriteJson(this.file, next)
  }

  getViduKey(): string | undefined {
    if (!this.cache.vidu) return undefined
    return this.decrypt(this.cache.vidu)
  }

  viduStatus(): DoubaoKeyStatus {
    if (!this.cache.vidu) return 'missing'
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
    return this.decrypt(this.cache.vidu) ? 'verified' : 'unreadable'
  }

  saveRtcAppKey(key: string): void {
    const encrypted = this.encrypt(key)
    if (!encrypted) throw new Error('系统加密不可用，无法安全保存 RTC AppKey')
    this.cache = { ...this.cache, rtcAppKey: encrypted }
    atomicWriteJson(this.file, this.cache)
  }

  clearRtcAppKey(): void {
    const next = { ...this.cache }
    delete next.rtcAppKey
    this.cache = next
    atomicWriteJson(this.file, next)
  }

  getRtcAppKey(): string | undefined {
    if (!this.cache.rtcAppKey) return undefined
    return this.decrypt(this.cache.rtcAppKey)
  }

  rtcAppKeyStatus(): DoubaoKeyStatus {
    if (!this.cache.rtcAppKey) return 'missing'
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
    return this.decrypt(this.cache.rtcAppKey) ? 'verified' : 'unreadable'
  }

  getDoubaoKey(): string | undefined {
    if (this.lastSaved) return this.lastSaved
    if (!this.cache.doubao) return undefined
    const plain = this.decrypt(this.cache.doubao)
    if (plain) this.lastSaved = plain
    return plain
  }

  doubaoStatus(): DoubaoKeyStatus {
    if (!this.cache.doubao) return 'missing'
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
    return this.decrypt(this.cache.doubao) ? 'verified' : 'unreadable'
  }
}
