/**
 * 全局 AppStore（Zustand）
 * - 布局状态（侧栏折叠、右栏宽度）
 * - 全局模型选择 / Max 模式
 * - runtime:event 订阅桥接（chat/artifacts store 消费统一事件流）
 */
import { create } from 'zustand';
import type { CustomProvider, ModelId, RuntimeEvent } from '@wdbuddy/shared-types';
import { BUILTIN_MODEL_NAMES } from '@wdbuddy/shared-types';
import { useEffect } from 'react';

export type SidePanelName = 'tasks' | 'skills' | 'preferences' | 'settings' | 'remote-link' | 'new-task' | 'templates' | null;

export type RuntimeState = 'idle' | 'running' | 'offline';

interface AppStore {
  // 布局（WorkBuddy 式：左栏常驻，成果区可隐藏）
  artifactsHidden: boolean;
  artifactWidth: number;
  toggleArtifacts(): void;
  setArtifactWidth(w: number): void;

  // 全局面板
  openPanel: SidePanelName;
  setOpenPanel(p: SidePanelName): void;

  // 模型 / Max
  currentModel: ModelId;
  setCurrentModel(m: ModelId): void;
  /** 启用的内置模型（用户可删除不用的内置模型，减少下拉噪音） */
  enabledBuiltin: ModelId[];
  setEnabledBuiltin(list: ModelId[]): void;
  /** 用户自定义 Provider（settings 同步，供顶栏/向导下拉渲染） */
  customProviders: CustomProvider[];
  setCustomProviders(list: CustomProvider[]): void;
  /** 全局自定义 Provider 表单（顶栏/设置页共用入口） */
  customProviderModal: { initial: CustomProvider | null; switchOnSave: boolean } | null;
  setCustomProviderModal(m: { initial: CustomProvider | null; switchOnSave: boolean } | null): void;
  maxMode: boolean;
  setMaxMode(v: boolean): void;

  // 状态栏
  runtimeState: RuntimeState;
  tokenCount: number;
  credits: number;
  setRuntimeState(s: RuntimeState): void;
  addTokens(n: number): void;
  setCredits(n: number): void;

  // 当前选中任务
  activeTaskId: string | null;
  setActiveTaskId(id: string | null): void;

  /** 跨面板指令注入（技能中心"一点即用"→ Composer 输入框草稿；消费后置 null） */
  composerDraft: string | null;
  setComposerDraft(text: string | null): void;

  // 事件桥接（chat/artifacts 经此分发，feature 间不直接通信）
  dispatchRuntimeEvent(e: RuntimeEvent): void;
  eventListeners: Set<(e: RuntimeEvent) => void>;
  subscribeRuntimeEvent(fn: (e: RuntimeEvent) => void): () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  artifactsHidden: false,
  artifactWidth: 400,
  toggleArtifacts: () => set((s) => ({ artifactsHidden: !s.artifactsHidden })),
  setArtifactWidth: (w) => set({ artifactWidth: w }),

  openPanel: null,
  setOpenPanel: (p) => set({ openPanel: p }),

  currentModel: 'auto',
  setCurrentModel: (m) => set({ currentModel: m }),
  enabledBuiltin: [],
  setEnabledBuiltin: (list) => set({ enabledBuiltin: list }),
  customProviders: [],
  setCustomProviders: (list) => set({ customProviders: list }),
  customProviderModal: null,
  setCustomProviderModal: (m) => set({ customProviderModal: m }),
  maxMode: false,
  setMaxMode: (v) => set({ maxMode: v }),

  runtimeState: 'idle',
  tokenCount: 0,
  credits: 1000,
  setRuntimeState: (s) => set({ runtimeState: s }),
  addTokens: (n) => set((s) => ({ tokenCount: s.tokenCount + n })),
  setCredits: (n) => set({ credits: n }),

  activeTaskId: null,
  setActiveTaskId: (id) => set({ activeTaskId: id }),

  composerDraft: null,
  setComposerDraft: (text) => set({ composerDraft: text }),

  dispatchRuntimeEvent: (e) => {
    // 状态栏更新
    if (e.type === 'token.delta') {
      get().addTokens(e.text.length);
    }
    if (e.type === 'task.done' || e.type === 'task.error' || e.type === 'task.rejected' || e.type === 'task.cancelled') {
      set({ runtimeState: 'idle' });
    }
    // 广播给订阅者（chat/artifacts store）
    for (const fn of get().eventListeners) fn(e);
  },
  eventListeners: new Set(),
  subscribeRuntimeEvent: (fn) => {
    const set0 = get().eventListeners;
    set0.add(fn);
    return () => set0.delete(fn);
  },
}));

/**
 * 可见模型清单（下拉框统一数据源）：仅"启用中的内置模型 + 自定义 Provider"。
 * 内置模型可被用户删除（删除即从 enabledBuiltin 移除），避免下拉里一堆用不到的模型。
 */
export function visibleModels(
  enabledBuiltin: readonly ModelId[],
  customProviders: readonly CustomProvider[]
): Array<{ id: ModelId; name: string }> {
  const list: Array<{ id: ModelId; name: string }> = [];
  for (const id of enabledBuiltin) {
    list.push({ id, name: BUILTIN_MODEL_NAMES[id] ?? id });
  }
  for (const p of customProviders) {
    list.push({ id: p.id as ModelId, name: p.name });
  }
  return list;
}

/** React hook：当前可见模型清单（顶栏/首页/向导/设置下拉共用） */
export function useVisibleModels(): Array<{ id: ModelId; name: string }> {
  const enabledBuiltin = useAppStore((s) => s.enabledBuiltin);
  const customProviders = useAppStore((s) => s.customProviders);
  return visibleModels(enabledBuiltin, customProviders);
}

/** React hook：订阅统一事件流（App 根部挂载一次，§10.2） */
export function useRuntimeEventBridge(): void {
  useEffect(() => {
    const api = (window as { wdbuddy?: { onRuntimeEvent: (cb: (e: RuntimeEvent) => void) => () => void } }).wdbuddy;
    if (!api) return;
    const unsub = api.onRuntimeEvent((event) => {
      useAppStore.getState().dispatchRuntimeEvent(event);
    });
    return unsub;
  }, []);
}
