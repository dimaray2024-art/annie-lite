/**
 * 非密设置。真实密钥不放这里（见 secrets.ts）。
 *
 * 设置是 UI 与主进程共用的状态，所以任何一次写入都可能来自用户手滑——
 * patch 合并而不是整体覆盖，避免一次局部更新把其它字段清空。
 */

import path from 'node:path'
import type { Settings, SettingsStatus, WorkspaceRoot } from '@shared/contract'
import { readJson, atomicWriteJson } from './store'

export const DEFAULT_SETTINGS: Settings = {
  workspaceRoots: [],
  pi: {
    mode: 'user-config',
    thinking: 'medium',
    maxConcurrentTasks: 1
  },
  voice: {
    instructions: '',
    userName: ''
  },
  memory: {
    vaultPath: ''
  },
  vidu: {
    enabled: false,
    apiHost: 'https://api.vidu.cn',
    model: 'vidu-s1',
    avatarImageUrl: '',
    rtcAppId: ''
  },
  confirmDestructive: true
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    pi: { ...base.pi, ...(patch.pi ?? {}) },
    voice: { ...base.voice, ...(patch.voice ?? {}) },
    memory: { ...base.memory, ...(patch.memory ?? {}) },
    vidu: { ...base.vidu, ...(patch.vidu ?? {}) },
    workspaceRoots: patch.workspaceRoots ?? base.workspaceRoots
  }
}

export class SettingsStore {
  private readonly file: string
  private current: Settings

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'settings.json')
    this.current = mergeSettings(DEFAULT_SETTINGS, readJson<Partial<Settings>>(this.file, {}))
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    this.current = mergeSettings(this.current, patch)
    atomicWriteJson(this.file, this.current)
    return this.current
  }

  addWorkspaceRoot(root: WorkspaceRoot): Settings {
    if (this.current.workspaceRoots.some((item) => item.id === root.id || item.path === root.path)) {
      return this.current
    }
    return this.update({ workspaceRoots: [...this.current.workspaceRoots, root] })
  }

  removeWorkspaceRoot(id: string): Settings {
    return this.update({ workspaceRoots: this.current.workspaceRoots.filter((item) => item.id !== id) })
  }

  /** 没配置知识库时指向默认位置，用户自己建了库也能直接被接上。 */
  ensureMemoryVault(defaultPath: string): Settings {
    if (this.current.memory.vaultPath) return this.current
    return this.update({ memory: { vaultPath: defaultPath } })
  }

  /** 首次启动时把主目录加进来，否则没有任何可访问的路径，工具一上来就全部失败。 */
  ensureDefaultRoot(home: string): Settings {
    if (this.current.workspaceRoots.length > 0) return this.current
    return this.addWorkspaceRoot({ id: 'home', name: '主目录', path: home })
  }

  status(patch: Omit<SettingsStatus, 'settings'>): SettingsStatus {
    return { settings: this.current, ...patch }
  }
}
