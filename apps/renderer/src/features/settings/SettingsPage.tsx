/**
 * SettingsPage — 设置页（§4.7）
 * 分组：通用 / 模型 / 权限与安全 / 积分与账号 / 关于
 */
import React, { useEffect, useState } from 'react';
import type { AppSettings, ModelId, ProviderKeyEntry } from '@wdbuddy/shared-types';
import { BUILTIN_MODEL_BASE_URLS, BUILTIN_MODEL_DEFAULTS, BUILTIN_MODEL_IDS, BUILTIN_MODEL_NAMES, DEFAULT_APP_SETTINGS } from '@wdbuddy/shared-types';
import { requireApi } from '../../shared/ipc';
import { useAppStore } from '../../shared/store';
import { MultimodalModelsSection } from './MultimodalModelsSection';
import { ModelCard } from './ModelCard';

type SettingsTab = 'general' | 'models' | 'permissions' | 'account' | 'about';



const TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: 'general', label: '通用' },
  { key: 'models', label: '模型' },
  { key: 'permissions', label: '权限与安全' },
  { key: 'account', label: '积分与账号' },
  { key: 'about', label: '关于' },
];

export function SettingsPage({ onClose }: { onClose: () => void }): React.ReactElement {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [keyEntries, setKeyEntries] = useState<ProviderKeyEntry[]>([]);
  /** modelId → 模型名覆盖（本地编辑态，保存时写入 settings.models.apiModelOverrides） */
  const [apiModels, setApiModels] = useState<Partial<Record<ModelId, string>>>({});
  /** modelId → 端点覆盖（本地编辑态，保存时写入 settings.models.apiBaseOverrides） */
  const [apiBases, setApiBases] = useState<Partial<Record<ModelId, string>>>({});


  useEffect(() => {
    void requireApi()
      .settingsGet()
      .then((s) => {
        setSettings(s);
        setApiModels(s.models.apiModelOverrides ?? {});
        setApiBases(s.models.apiBaseOverrides ?? {});
        // 内置模型可删除：把"启用清单"同步到全局 store，供顶栏/首页/向导下拉使用
        useAppStore
          .getState()
          .setEnabledBuiltin(s.models.enabledBuiltin ?? [...BUILTIN_MODEL_IDS]);
      });
    void requireApi()
      .providerKeyList()
      .then((r) => setKeyEntries(r.keys));
  }, []);



  /** 启用的内置模型清单：缺省（undefined）= 全部启用。
   *  内置模型同样可删除——多数用户只对接 1~2 家服务，留一堆用不到的模型
   *  只会让下拉与密钥表变成噪音。 */
  const enabledBuiltin: ModelId[] = settings.models.enabledBuiltin ?? [...BUILTIN_MODEL_IDS];
  /** 已被删除（可恢复）的内置模型 */
  const disabledBuiltin = BUILTIN_MODEL_IDS.filter((id) => !enabledBuiltin.includes(id));
  /** 可见模型（默认模型下拉数据源）：启用中的内置 + 自定义 */
  const visibleList: Array<{ id: ModelId; name: string }> = [
    ...enabledBuiltin.map((id) => ({ id, name: BUILTIN_MODEL_NAMES[id] ?? id })),
    ...settings.models.customProviders.map((p) => ({ id: p.id as ModelId, name: p.name })),
  ];

  /** 删除内置模型：从启用清单移除 + 清理密钥与模型名覆盖 + 默认模型回退 */
  const handleRemoveBuiltin = async (id: ModelId): Promise<void> => {
    const api = requireApi();
    const nextEnabled = enabledBuiltin.filter((m) => m !== id);
    const nextOverrides = { ...(settings.models.apiModelOverrides ?? {}) };
    delete nextOverrides[id];
    const nextBaseOverrides = { ...(settings.models.apiBaseOverrides ?? {}) };
    delete nextBaseOverrides[id];
    const nextApiModels = { ...apiModels };
    delete nextApiModels[id];
    const nextApiBases = { ...apiBases };
    delete nextApiBases[id];
    const next: AppSettings = {
      ...settings,
      models: {
        ...settings.models,
        enabledBuiltin: nextEnabled,
        apiModelOverrides: nextOverrides,
        apiBaseOverrides: nextBaseOverrides,
        // 默认模型指向被删模型时回退 Auto，避免下次任务启动直接报"模型未配置"
        defaultModelId: settings.models.defaultModelId === id ? 'auto' : settings.models.defaultModelId,
      },
    };
    await api.settingsSet(next);
    await api.providerKeySet(id, '');
    setApiModels(nextApiModels);
    setApiBases(nextApiBases);
    setSettings(next);
    useAppStore.getState().setEnabledBuiltin(nextEnabled);
    // 顶栏当前选中的正是被删除模型时回退 Auto，避免下一条消息仍按已删模型发起
    if (useAppStore.getState().currentModel === id) {
      useAppStore.getState().setCurrentModel('auto');
    }
    void api
      .providerKeyList()
      .then((r) => setKeyEntries(r.keys))
      .catch(() => undefined);
  };

  /** 恢复内置模型（不覆盖已有配置，仅重新加入下拉清单） */
  const handleRestoreBuiltin = async (id: ModelId): Promise<void> => {
    const api = requireApi();
    const nextEnabled = [...enabledBuiltin, id];
    const next: AppSettings = {
      ...settings,
      models: { ...settings.models, enabledBuiltin: nextEnabled },
    };
    await api.settingsSet(next);
    setSettings(next);
    useAppStore.getState().setEnabledBuiltin(nextEnabled);
  };

  const save = async (): Promise<void> => {
    const api = requireApi();
    // 每个模型卡片内的 API Key 都是"立即保存"，此处无需再提交草稿
    void api
      .providerKeyList()
      .then((r) => setKeyEntries(r.keys))
      .catch(() => undefined);
    // 模型名 / 端点覆盖：剔除空白项后合并进 settings（空 = 恢复内置默认）
    const overrides: Partial<Record<ModelId, string>> = {};
    for (const [k, v] of Object.entries(apiModels)) {
      const t = (v ?? '').trim();
      if (t) overrides[k as ModelId] = t;
    }
    const baseOverrides: Partial<Record<ModelId, string>> = {};
    for (const [k, v] of Object.entries(apiBases)) {
      const t = (v ?? '').trim();
      if (t) baseOverrides[k as ModelId] = t;
    }
    const next: AppSettings = {
      ...settings,
      models: {
        ...settings.models,
        apiModelOverrides: overrides,
        apiBaseOverrides: baseOverrides,
        enabledBuiltin: settings.models.enabledBuiltin ?? [...BUILTIN_MODEL_IDS],
      },
    };
    await api.settingsSet(next);
    setSettings(next);
    useAppStore.getState().setEnabledBuiltin(next.models.enabledBuiltin ?? [...BUILTIN_MODEL_IDS]);
    // 内联编辑的自定义 Provider（名称/端点/模型名）也要同步到全局 store，
    // 否则顶栏与首页下拉仍显示旧值
    useAppStore.getState().setCustomProviders(next.models.customProviders);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  /** 关闭：每个模型卡片的 API Key 都是"立即保存"，不存在未提交草稿 */
  const closeWithGuard = (): void => onClose();

  /** 全局弹窗（App 层）保存/删除自定义 Provider 后同步本地 settings，避免旧列表被“保存”回写。
   *  深比较全部字段：旧实现仅比 id——编辑名称/BaseURL/API Key 后 id 不变，
   *  本地列表不刷新，设置页仍显示旧值，用户误以为"保存没生效"。 */
  const storeCustomProviders = useAppStore((s) => s.customProviders);
  useEffect(() => {
    setSettings((prev) => {
      const same = JSON.stringify(prev.models.customProviders) === JSON.stringify(storeCustomProviders);
      return same ? prev : { ...prev, models: { ...prev.models, customProviders: storeCustomProviders } };
    });
    // 弹窗可能写入新密钥 → 刷新脱敏密钥状态（自定义 Provider 行展示"密钥已配置"）
    void requireApi()
      .providerKeyList()
      .then((r) => setKeyEntries(r.keys))
      .catch(() => undefined);
  }, [storeCustomProviders]);

  /** 删除自定义 Provider：移除列表 + 清理密钥（主进程热更新 Runtime 网关） */
  const handleRemove = async (id: string): Promise<void> => {
    const api = requireApi();
    const next: AppSettings = {
      ...settings,
      models: { ...settings.models, customProviders: settings.models.customProviders.filter((p) => p.id !== id) },
    };
    await api.settingsSet(next);
    await api.providerKeySet(id as ModelId, '');
    useAppStore.getState().setCustomProviders(next.models.customProviders);
    setSettings(next);
  };

  return (
    <div className="wb-modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wb-modal" style={{ minWidth: 640 }}>
        <div className="wb-modal__header">设置</div>
        <div className="wb-settings__body">
          <div className="wb-settings__nav">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`wb-settings__nav-item ${tab === t.key ? 'wb-settings__nav-item--active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="wb-settings__content">
            {tab === 'general' && (
              <>
                <SettingsRow label="语言">
                  <select className="wb-select" value={settings.general.language} onChange={(e) => setSettings({ ...settings, general: { ...settings.general, language: e.target.value as AppSettings['general']['language'] } })}>
                    <option value="zh-CN">简体中文</option>
                    <option value="en-US">English</option>
                  </select>
                </SettingsRow>
                <SettingsRow label="主题">
                  <select className="wb-select" value={settings.general.theme} onChange={(e) => {
                    const theme = e.target.value as AppSettings['general']['theme'];
                    setSettings({ ...settings, general: { ...settings.general, theme } });
                    localStorage.setItem('wb-theme', theme);
                    document.documentElement.setAttribute('data-theme', theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme);
                  }}>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                    <option value="auto">跟随系统</option>
                  </select>
                </SettingsRow>
                <SettingsRow label="开机自启">
                  <input type="checkbox" checked={settings.general.launchAtLogin} onChange={(e) => setSettings({ ...settings, general: { ...settings.general, launchAtLogin: e.target.checked } })} />
                </SettingsRow>
                <SettingsRow label="遥测（默认关闭，NFR-06）">
                  <input type="checkbox" checked={settings.general.telemetry} onChange={(e) => setSettings({ ...settings, general: { ...settings.general, telemetry: e.target.checked } })} />
                </SettingsRow>
              </>
            )}

            {tab === 'models' && (
              <>
                <SettingsRow label="默认 LLM 模型">
                  <select className="wb-select" value={settings.models.defaultModelId} onChange={(e) => setSettings({ ...settings, models: { ...settings.models, defaultModelId: e.target.value as AppSettings['models']['defaultModelId'] } })}>
                    <option value="auto">Auto（自动选择）</option>
                    {visibleList.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                    {settings.models.defaultModelId !== 'auto' &&
                      !visibleList.some((m) => m.id === settings.models.defaultModelId) && (
                        <option value={settings.models.defaultModelId}>
                          {BUILTIN_MODEL_NAMES[settings.models.defaultModelId] ??
                            settings.models.defaultModelId}
                          （已删除）
                        </option>
                      )}
                  </select>
                  {visibleList.length === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--wb-color-warning)', marginTop: 4 }}>
                      当前没有任何模型。请添加自定义 Provider，或恢复内置模型。
                    </div>
                  )}
                </SettingsRow>

                <MultimodalModelsSection settings={settings} setSettings={setSettings} />

                {/* 内置模型：与多模态模型、自定义 Provider 完全相同的卡片版式
                    （显示名 / Base URL / 模型名 / API Key / 设为默认 / 删除） */}
                {enabledBuiltin.map((id) => {
                  const entry = keyEntries.find((k) => k.modelId === id);
                  const isDefault = settings.models.defaultModelId === id;
                  return (
                    <ModelCard
                      key={id}
                      title={BUILTIN_MODEL_NAMES[id] ?? id}
                      isDefault={isDefault}
                      nameEditable={false}
                      name={BUILTIN_MODEL_NAMES[id] ?? id}
                      baseUrl={apiBases[id] ?? ''}
                      apiModel={apiModels[id] ?? ''}
                      baseUrlPlaceholder={`Base URL（默认 ${BUILTIN_MODEL_BASE_URLS[id] ?? ''}）`}
                      apiModelPlaceholder={`模型名（默认 ${BUILTIN_MODEL_DEFAULTS[id] ?? ''}）`}
                      masked={entry?.masked ?? ''}
                      onPatch={(patch) => {
                        if (patch.baseUrl !== undefined) {
                          setApiBases((prev) => ({ ...prev, [id]: patch.baseUrl as string }));
                        }
                        if (patch.apiModel !== undefined) {
                          setApiModels((prev) => ({ ...prev, [id]: patch.apiModel as string }));
                        }
                      }}
                      onSaveKey={async (apiKey) => {
                        await requireApi().providerKeySet(id, apiKey);
                        void requireApi()
                          .providerKeyList()
                          .then((r) => setKeyEntries(r.keys))
                          .catch(() => undefined);
                      }}
                      onSetDefault={() =>
                        setSettings((prev) => ({
                          ...prev,
                          models: { ...prev.models, defaultModelId: id },
                        }))
                      }
                      onDelete={() => {
                        if (
                          !window.confirm(
                            `确定删除内置模型「${BUILTIN_MODEL_NAMES[id] ?? id}」？\n将同时清除其 API Key、Base URL 与模型名配置，可从下方“恢复内置模型”重新加入。`
                          )
                        )
                          return;
                        void handleRemoveBuiltin(id);
                      }}
                      deleteHint="从模型列表移除（同时清除该模型的 API Key、Base URL 与模型名）"
                    />
                  );
                })}

                {disabledBuiltin.length > 0 && (
                  <SettingsRow label="恢复内置模型">
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {disabledBuiltin.map((id) => (
                        <button
                          key={id}
                          className="wb-btn wb-btn--ghost wb-btn--small"
                          title="重新加入模型列表（不恢复已清除的密钥）"
                          onClick={() => void handleRestoreBuiltin(id)}
                        >
                          ＋ {BUILTIN_MODEL_NAMES[id] ?? id}
                        </button>
                      ))}
                    </div>
                  </SettingsRow>
                )}



                {/* 自定义 Provider：同样使用统一卡片版式，编辑与删除位置内联可见 */}
                {settings.models.customProviders.length === 0 && (
                  <SettingsRow label="自定义 Provider">
                    <span style={{ fontSize: 12, color: 'var(--wb-text-secondary)' }}>
                      暂无（OpenAI 兼容 API：Base URL + 模型名 + API Key，密钥存系统钥匙串）
                    </span>
                  </SettingsRow>
                )}
                {settings.models.customProviders.map((p) => {
                  const entry = keyEntries.find((k) => k.modelId === p.id);
                  const isDefault = settings.models.defaultModelId === p.id;
                  return (
                    <ModelCard
                      key={p.id}
                      title={p.name}
                      isDefault={isDefault}
                      nameEditable
                      name={p.name}
                      baseUrl={p.baseUrl}
                      apiModel={p.apiModel}
                      masked={entry?.masked ?? ''}
                      onPatch={(patch) => {
                        setSettings((prev) => ({
                          ...prev,
                          models: {
                            ...prev.models,
                            customProviders: prev.models.customProviders.map((item) =>
                              item.id === p.id
                                ? {
                                    ...item,
                                    ...(patch.name !== undefined ? { name: patch.name } : {}),
                                    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
                                    ...(patch.apiModel !== undefined ? { apiModel: patch.apiModel } : {}),
                                  }
                                : item
                            ),
                          },
                        }));
                      }}
                      onSaveKey={async (apiKey) => {
                        await requireApi().providerKeySet(p.id as ModelId, apiKey);
                        void requireApi()
                          .providerKeyList()
                          .then((r) => setKeyEntries(r.keys))
                          .catch(() => undefined);
                      }}
                      onSetDefault={() =>
                        setSettings((prev) => ({
                          ...prev,
                          models: { ...prev.models, defaultModelId: p.id as ModelId },
                        }))
                      }
                      onDelete={() => {
                        if (!window.confirm(`确定删除自定义 Provider「${p.name}」？\n其 API Key 将一并清除。`)) return;
                        void handleRemove(p.id);
                      }}
                      deleteHint="删除该自定义 Provider（同时清除其 API Key）"
                    />
                  );
                })}
                <SettingsRow label="添加自定义 Provider">
                  <button
                    className="wb-btn wb-btn--default wb-btn--small"
                    onClick={() =>
                      useAppStore.getState().setCustomProviderModal({ initial: null, switchOnSave: false })
                    }
                  >
                    ＋ 添加自定义 Provider
                  </button>
                </SettingsRow>
              </>
            )}

            {tab === 'permissions' && (
              <>
                <SettingsRow label="默认权限级别">
                  <select className="wb-select" value={settings.permissions.defaultPermission} onChange={(e) => setSettings({ ...settings, permissions: { ...settings.permissions, defaultPermission: e.target.value as AppSettings['permissions']['defaultPermission'] } })}>
                    <option value="default">默认权限（敏感操作逐次确认）</option>
                    <option value="full">完全访问（免确认，慎用）</option>
                  </select>
                </SettingsRow>
                <SettingsRow label="shell 执行前确认">
                  <input type="checkbox" checked={settings.permissions.confirmBeforeShell} onChange={(e) => setSettings({ ...settings, permissions: { ...settings.permissions, confirmBeforeShell: e.target.checked } })} />
                </SettingsRow>
                <SettingsRow label="工作空间外写入确认">
                  <input type="checkbox" checked={settings.permissions.confirmBeforeWriteOutsideWorkspace} onChange={(e) => setSettings({ ...settings, permissions: { ...settings.permissions, confirmBeforeWriteOutsideWorkspace: e.target.checked } })} />
                </SettingsRow>
                <SettingsRow label="授权目录">
                  <div style={{ fontSize: 12 }}>
                    {settings.workspaces.length === 0 ? '（无）' : settings.workspaces.map((w) => `📁 ${w}`).join('\n')}
                  </div>
                </SettingsRow>
              </>
            )}

            {tab === 'account' && (
              <>
                <SettingsRow label="登录状态">
                  <button className="wb-btn wb-btn--default" onClick={() => undefined}>微信扫码登录</button>
                </SettingsRow>
                <SettingsRow label="积分余额 / 用量明细">
                  <div style={{ fontSize: 12, color: 'var(--wb-text-secondary)' }}>登录后展示余额与模型调用扣减明细（FR-21）</div>
                </SettingsRow>
                <SettingsRow label="退出登录">
                  <button className="wb-btn wb-btn--ghost" onClick={() => undefined}>退出</button>
                </SettingsRow>
              </>
            )}

            {tab === 'about' && (
              <>
                <SettingsRow label="版本">v1.0.0</SettingsRow>
                <SettingsRow label="检查更新">
                  <button className="wb-btn wb-btn--default" onClick={() => undefined}>检查更新</button>
                </SettingsRow>
                <SettingsRow label="导出诊断日志">
                  <button className="wb-btn wb-btn--default" onClick={() => undefined}>导出（用户主动，日志已脱敏）</button>
                </SettingsRow>
              </>
            )}
          </div>
        </div>
        <div className="wb-modal__footer">
          {saved && <span style={{ color: 'var(--wb-color-success)', marginRight: 8 }}>已保存</span>}
          <button className="wb-btn wb-btn--ghost" onClick={closeWithGuard}>关闭</button>
          <button
            className="wb-btn wb-btn--primary"
            title="保存当前全部设置项（含已输入未提交的 API Key）"
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="wb-settings__row">
      <div className="wb-settings__row-label">{label}</div>
      <div className="wb-settings__row-value">{children}</div>
    </div>
  );
}

/** Provider Key 行：受控草稿输入 + 立即保存（草稿由父组件统一管理，底部"保存"亦会提交） */
function ProviderKeyRow({
  masked,
  value,
  onChange,
  onImmediateSave,
}: {
  masked: string;
  value: string;
  onChange: (v: string) => void;
  onImmediateSave: (apiKey: string) => Promise<void>;
}): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const canSave = value.trim().length > 0;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onImmediateSave(value.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        className="wb-input"
        style={{ width: 260 }}
        type="password"
        value={value}
        placeholder={masked ? `已配置（${masked}），输入新值覆盖` : '未配置，输入 API Key'}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <button className="wb-btn wb-btn--default wb-btn--small" disabled={!canSave || saving} onClick={() => void save()}>
        {saving ? '保存中…' : '立即保存'}
      </button>
    </div>
  );
}
