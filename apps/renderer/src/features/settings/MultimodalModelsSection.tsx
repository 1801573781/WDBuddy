/**
 * MultimodalModelsSection — 多模态（读图）模型管理
 *
 * 与 LLM 模型完全平级：可添加多个、可逐个删除、可指定默认其一。
 * 每个模型独立保存 ApiKey（钥匙串 vision:<id>），删除模型时同步清除密钥。
 *
 * 设计说明：
 * - 不提供"图片传输形态"开关：客户端会先按 data URL 发送，端点拒收时自动
 *   回退裸 base64，用户无需关心协议细节。
 * - 不展示"已就绪/未配置"之类的状态徽标：密钥行本身的 placeholder 已说明一切。
 */
import React, { useEffect, useState } from 'react';
import type { AppSettings, MultimodalModel } from '@wdbuddy/shared-types';
import { requireApi } from '../../shared/ipc';

/** 添加模型时的常见端点预设（选中即填入 Base URL 与模型名，仍可手动改） */
const PRESETS: Array<{ label: string; baseUrl: string; apiModel: string }> = [
  { label: '智谱 GLM-4V', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiModel: 'glm-4v-plus' },
  { label: 'OpenAI GPT-4o', baseUrl: 'https://api.openai.com/v1', apiModel: 'gpt-4o' },
  {
    label: '通义 Qwen-VL',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiModel: 'qwen-vl-plus',
  },
  { label: '月之暗面 Kimi Vision', baseUrl: 'https://api.moonshot.cn/v1', apiModel: 'moonshot-v1-32k-vision-preview' },
];

let seq = 0;
function newId(): string {
  seq += 1;
  return `mm-${Date.now().toString(36)}-${seq}`;
}

export function MultimodalModelsSection({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}): React.ReactElement {
  const models: MultimodalModel[] = settings.models.multimodalModels ?? [];
  const defaultId = settings.models.defaultMultimodalId ?? models[0]?.id ?? '';
  /** id → 脱敏密钥状态 */
  const [keyStatus, setKeyStatus] = useState<Record<string, { hasKey: boolean; masked: string }>>({});
  /** id → 输入中的密钥草稿（每行独立"立即保存"） */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refreshKeys = async (): Promise<void> => {
    try {
      const r = await requireApi().visionKeyList();
      const next: Record<string, { hasKey: boolean; masked: string }> = {};
      for (const k of r.keys) next[k.id] = { hasKey: k.hasKey, masked: k.masked };
      setKeyStatus(next);
    } catch {
      /* 非 Electron 环境忽略 */
    }
  };

  useEffect(() => {
    void refreshKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchModels = (next: MultimodalModel[], nextDefault?: string): void => {
    setSettings((prev) => ({
      ...prev,
      models: {
        ...prev.models,
        multimodalModels: next,
        defaultMultimodalId: nextDefault ?? (next.some((m) => m.id === defaultId) ? defaultId : (next[0]?.id ?? '')),
      },
    }));
  };

  const updateOne = (id: string, patch: Partial<MultimodalModel>): void => {
    patchModels(models.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const addModel = (preset?: (typeof PRESETS)[number]): void => {
    const item: MultimodalModel = {
      id: newId(),
      name: preset?.label ?? '新多模态模型',
      baseUrl: preset?.baseUrl ?? '',
      apiModel: preset?.apiModel ?? '',
    };
    patchModels([...models, item], defaultId || item.id);
  };

  /** 删除模型：从列表移除 → 清空其密钥 → 默认项回退到剩余第一个 */
  const removeModel = async (id: string): Promise<void> => {
    const next = models.filter((m) => m.id !== id);
    const nextDefault = defaultId === id ? (next[0]?.id ?? '') : defaultId;
    patchModels(next, nextDefault);
    try {
      await requireApi().visionKeySet(id, '');
    } catch {
      /* 忽略：配置保存时会再次对账 */
    }
    void refreshKeys();
  };

  const saveKey = async (id: string): Promise<void> => {
    const value = (drafts[id] ?? '').trim();
    if (!value) return;
    await requireApi().visionKeySet(id, value);
    setDrafts((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    void refreshKeys();
  };

  return (
    <>
      <div className="wb-settings__row">
        <div className="wb-settings__row-label">默认多模态模型</div>
        <div className="wb-settings__row-value">
          <select
            className="wb-select"
            value={defaultId}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                models: { ...prev.models, defaultMultimodalId: e.target.value },
              }))
            }
            disabled={models.length === 0}
          >
            {models.length === 0 && <option value="">未配置（读图能力不可用）</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.apiModel || m.id}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: 'var(--wb-text-secondary)', marginTop: 4 }}>
            多模态模型负责读图（截图、设计稿、表格、报错界面）。与 LLM 模型分开管理，可配置多个、任选其一。
          </div>
        </div>
      </div>

      {models.map((m) => {
        const status = keyStatus[m.id];
        const isDefault = m.id === defaultId;
        return (
          <div className="wb-settings__row" key={m.id}>
            <div className="wb-settings__row-label">
              {isDefault ? '★ ' : ''}
              {m.name || '多模态模型'}
            </div>
            <div className="wb-settings__row-value">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <input
                    className="wb-input"
                    style={{ width: 160 }}
                    value={m.name}
                    placeholder="显示名（如 智谱 GLM-4V）"
                    onChange={(e) => updateOne(m.id, { name: e.target.value })}
                  />
                  <input
                    className="wb-input"
                    style={{ width: 300 }}
                    value={m.baseUrl}
                    placeholder="Base URL（如 https://open.bigmodel.cn/api/paas/v4）"
                    onChange={(e) => updateOne(m.id, { baseUrl: e.target.value })}
                  />
                  <input
                    className="wb-input"
                    style={{ width: 200 }}
                    value={m.apiModel}
                    placeholder="模型名（如 glm-4v-plus）"
                    onChange={(e) => updateOne(m.id, { apiModel: e.target.value })}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    className="wb-input"
                    style={{ width: 260 }}
                    type="password"
                    autoComplete="off"
                    value={drafts[m.id] ?? ''}
                    placeholder={
                      status?.hasKey ? `已配置（${status.masked}），输入新值覆盖` : '未配置，输入 API Key'
                    }
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                  />
                  <button
                    className="wb-btn wb-btn--default wb-btn--small"
                    disabled={!(drafts[m.id] ?? '').trim()}
                    onClick={() => void saveKey(m.id)}
                  >
                    立即保存
                  </button>
                  <button
                    className={`wb-btn wb-btn--small ${isDefault ? 'wb-btn--primary' : 'wb-btn--ghost'}`}
                    title="设为默认多模态模型"
                    onClick={() =>
                      setSettings((prev) => ({
                        ...prev,
                        models: { ...prev.models, defaultMultimodalId: m.id },
                      }))
                    }
                  >
                    {isDefault ? '当前默认' : '设为默认'}
                  </button>
                  <button
                    className="wb-btn wb-btn--ghost wb-btn--small"
                    title="删除该多模态模型（同时清除其 API Key）"
                    onClick={() => {
                      if (!window.confirm(`确定删除多模态模型「${m.name || m.apiModel || m.id}」？\n其 API Key 将一并清除。`)) return;
                      void removeModel(m.id);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <div className="wb-settings__row">
        <div className="wb-settings__row-label">添加多模态模型</div>
        <div className="wb-settings__row-value">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="wb-btn wb-btn--ghost wb-btn--small"
                onClick={() => addModel(p)}
                title={`${p.baseUrl} · ${p.apiModel}`}
              >
                ＋ {p.label}
              </button>
            ))}
            <button className="wb-btn wb-btn--default wb-btn--small" onClick={() => addModel()}>
              ＋ 自定义
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
