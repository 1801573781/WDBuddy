/**
 * ModelCard — 模型配置的统一版式（LLM 内置、自定义 Provider、多模态模型共用）
 *
 * 为什么统一：此前三类模型各写一套 UI——内置模型只有"密钥+模型名"，自定义
 * Provider 只有一行只读摘要，多模态模型又是另一套。用户在不同区块找不到
 * 同一个配置项，"删除"按钮位置也各不相同（有的在密钥右侧、有的在行尾）。
 *
 * 统一后的版式：
 *   ★ 显示名（默认项加星）
 *     [显示名] [Base URL] [模型名]
 *     [API Key 输入框] [立即保存]
 *     [设为默认] [删除]
 * 删除按钮固定在区块底部一行，与「设为默认」并列，不再挤在输入框右边。
 */
import React, { useState } from 'react';

export interface ModelCardProps {
  /** 左侧标题（默认项前自动加 ★） */
  title: string;
  isDefault: boolean;
  /** 显示名是否可编辑（内置模型的显示名固定，自定义/多模态可改） */
  nameEditable: boolean;
  name: string;
  baseUrl: string;
  apiModel: string;
  /** Base URL 输入框占位（内置模型给出真实默认地址） */
  baseUrlPlaceholder?: string;
  apiModelPlaceholder?: string;
  /** 脱敏后的密钥（无密钥为空串） */
  masked: string;
  /** 是否允许设为默认（如 Auto 场景下可能禁用） */
  canSetDefault?: boolean;
  onPatch(patch: { name?: string; baseUrl?: string; apiModel?: string }): void;
  onSaveKey(apiKey: string): Promise<void> | void;
  onSetDefault(): void;
  onDelete(): void;
  /** 删除按钮提示文案 */
  deleteHint?: string;
}

export function ModelCard(props: ModelCardProps): React.ReactElement {
  const [draftKey, setDraftKey] = useState('');
  const [saving, setSaving] = useState(false);

  const saveKey = async (): Promise<void> => {
    const v = draftKey.trim();
    if (!v) return;
    setSaving(true);
    try {
      await props.onSaveKey(v);
      setDraftKey('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wb-settings__row">
      <div className="wb-settings__row-label">
        {props.isDefault ? '★ ' : ''}
        {props.title}
      </div>
      <div className="wb-settings__row-value">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* 第一行：显示名 / Base URL / 模型名 */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {props.nameEditable ? (
              <input
                className="wb-input"
                style={{ width: 160 }}
                value={props.name}
                placeholder="显示名（如 智谱 GLM-4V）"
                onChange={(e) => props.onPatch({ name: e.target.value })}
              />
            ) : (
              <span
                style={{
                  width: 160,
                  fontSize: 12,
                  color: 'var(--wb-text-secondary)',
                  alignSelf: 'center',
                }}
                title="内置模型显示名固定，模型名可在右侧修改"
              >
                {props.title}
              </span>
            )}
            <input
              className="wb-input"
              style={{ width: 300 }}
              value={props.baseUrl}
              placeholder={props.baseUrlPlaceholder ?? 'Base URL（如 https://open.bigmodel.cn/api/paas/v4）'}
              onChange={(e) => props.onPatch({ baseUrl: e.target.value })}
            />
            <input
              className="wb-input"
              style={{ width: 200 }}
              value={props.apiModel}
              placeholder={props.apiModelPlaceholder ?? '模型名（如 glm-4v-plus）'}
              onChange={(e) => props.onPatch({ apiModel: e.target.value })}
            />
          </div>

          {/* 第二行：API Key + 立即保存 */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="wb-input"
              style={{ width: 260 }}
              type="password"
              autoComplete="off"
              value={draftKey}
              placeholder={
                props.masked ? `已配置（${props.masked}），输入新值覆盖` : '未配置，输入 API Key'
              }
              onChange={(e) => setDraftKey(e.target.value)}
            />
            <button
              className="wb-btn wb-btn--default wb-btn--small"
              disabled={!draftKey.trim() || saving}
              onClick={() => void saveKey()}
            >
              {saving ? '保存中…' : '立即保存'}
            </button>
          </div>

          {/* 第三行：设为默认 / 删除（操作按钮统一固定在底部，不挤占输入框） */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className={`wb-btn wb-btn--small ${props.isDefault ? 'wb-btn--primary' : 'wb-btn--ghost'}`}
              disabled={props.isDefault || props.canSetDefault === false}
              title="设为默认模型"
              onClick={() => props.onSetDefault()}
            >
              {props.isDefault ? '当前默认' : '设为默认'}
            </button>
            <button
              className="wb-btn wb-btn--ghost wb-btn--small"
              title={props.deleteHint ?? '从模型列表移除（同时清除其 API Key）'}
              onClick={() => props.onDelete()}
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
