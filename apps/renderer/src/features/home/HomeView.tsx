/**
 * HomeView — WorkBuddy 式首页（无选中任务时的主区视图）
 * - 大标题 hero + 猫形机器人吉祥物（SVG）
 * - 3 个类别胶囊（日常办公/代码开发/设计创意）+ 可滚动快捷功能胶囊
 * - 大输入卡：+ 按钮 / 模型下拉 / 麦克风（接口）/ 深色圆形发送钮
 * - 输入卡下方选项行：选择工作空间 / 权限（复用既有设置）
 * - 右上角"做任务赢积分好礼"浮动胶囊（营销接口，暂未实现跳转）
 */
import React, { useEffect, useState } from 'react';
import type { TaskMode } from '@wdbuddy/shared-types';
import { BUILTIN_MODEL_NAMES } from '@wdbuddy/shared-types';
import { useAppStore, useVisibleModels } from '../../shared/store';
import { requireApi } from '../../shared/ipc';
import './styles.css';

/** 类别胶囊（图1：日常办公/代码开发/设计创意，选中深黑底白字） */
const CATEGORIES = ['日常办公', '代码开发', '设计创意'];

/** 快捷功能胶囊（图1：文档处理 → 视频生成，可横向滚动） */
const QUICK_FEATURES = [
  '文档处理', '金融服务', '数据分析及可视化', '个人工作台', '幻灯片', '深度研究', '视频生成',
];

export function HomeView(): React.ReactElement {
  const [text, setText] = useState('');
  const [category, setCategory] = useState<string>(CATEGORIES[0]!);
  const [mode, setMode] = useState<TaskMode>('plan');
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [wsUri, setWsUri] = useState<string>('');
  const [permission, setPermission] = useState<'default' | 'full'>('default');
  const currentModel = useAppStore((s) => s.currentModel);
  const maxMode = useAppStore((s) => s.maxMode);
  // 只展示"启用中的内置模型 + 自定义 Provider"（内置模型可被用户删除）
  const models = useVisibleModels();

  // 工作空间列表（选项行下拉）与权限默认值
  useEffect(() => {
    requireApi()
      .settingsGet()
      .then((s) => {
        setWorkspaces(s.workspaces);
        setPermission(s.permissions.defaultPermission);
      })
      .catch(() => undefined);
  }, []);

  /** 发送：与 Composer 相同链路（创建任务并启动），完成后切到任务对话 */
  const send = async (): Promise<void> => {
    const instruction = text.trim();
    if (!instruction) return;
    const api = requireApi();
    const { taskId } = await api.taskCreate({
      description: instruction,
      mode,
      workspaceUri: wsUri || null,
      permission,
      modelId: currentModel,
      maxContext: maxMode,
      trigger: { type: 'manual' },
    });
    useAppStore.getState().setActiveTaskId(taskId);
    await api.taskControl({ taskId, action: 'start' });
    useAppStore.getState().setRuntimeState('running');
    setText('');
  };

  return (
    <div className="wb-home">
      {/* 营销浮动胶囊（右上角，接口：待云端运营活动接入） */}
      <button
        className="wb-home__float-ad"
        title="营销活动（未实现）：接入运营活动后跳转活动页"
        onClick={() => undefined}
      >
        <span className="wb-home__float-ad-icon">🎁</span> 做任务赢积分好礼
      </button>

      <div className="wb-home__hero">
        <div className="wb-home__title">WDBuddy, 我帮你</div>
        <BuddyMascot />
      </div>

      {/* 类别胶囊 */}
      <div className="wb-home__categories">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className={`wb-home__cat ${category === c ? 'wb-home__cat--active' : ''}`}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
      </div>

      {/* 快捷功能（横向滚动） */}
      <div className="wb-home__quick">
        {QUICK_FEATURES.map((f) => (
          <button
            key={f}
            className="wb-home__quick-chip"
            title={`${f}（快捷指令模板，待接入）`}
            onClick={() => setText((t) => (t ? `${t} ${f}` : `帮我处理${f}：`))}
          >
            {f}
          </button>
        ))}
        <span className="wb-home__quick-arrow">›</span>
      </div>

      {/* 输入卡 */}
      <div className="wb-home__card">
        <textarea
          className="wb-home__input"
          placeholder="今天帮你做些什么？ @ 引用对话文件，/ 调用技能与指令"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="wb-home__card-bar">
          <button className="wb-home__plus" title="附件：引用对话文件（待接入）">＋</button>
          <div className="wb-home__card-spacer" />
          <select
            className="wb-home__model"
            value={currentModel}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'custom:api') {
                useAppStore.getState().setCustomProviderModal({ initial: null, switchOnSave: true });
                return;
              }
              useAppStore.getState().setCurrentModel(v as never);
            }}
            title="模型选择"
          >
            <option value="auto">Auto（自动选择）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
            {currentModel !== 'auto' && !models.some((m) => m.id === currentModel) && (
              <option value={currentModel}>
                {BUILTIN_MODEL_NAMES[currentModel] ?? currentModel}（不可用）
              </option>
            )}
            <option value="custom:api">＋ 添加自定义模型…</option>
          </select>
          <button className="wb-home__mic" title="语音输入（接口，待接入）">🎙</button>
          <button
            className={`wb-home__send ${text.trim() ? '' : 'is-disabled'}`}
            title="发送"
            disabled={!text.trim()}
            onClick={() => void send()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* 选项行：工作空间 + 权限（复用既有设置） */}
      <div className="wb-home__options">
        <select
          className="wb-home__option"
          value={wsUri}
          onChange={(e) => setWsUri(e.target.value)}
          title="选择工作空间"
        >
          <option value="">选择工作空间</option>
          {workspaces.map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
        <select
          className="wb-home__option"
          value={permission}
          onChange={(e) => setPermission(e.target.value as 'default' | 'full')}
          title="默认权限"
        >
          <option value="default">默认权限</option>
          <option value="full">完全权限</option>
        </select>
      </div>
    </div>
  );
}

/** 猫形机器人吉祥物（SVG 简笔，WorkBuddy 式） */
function BuddyMascot(): React.ReactElement {
  return (
    <div className="wb-home__mascot" aria-hidden="true">
      <svg width="72" height="72" viewBox="0 0 72 72">
        {/* 头顶绿色小图标 */}
        <circle cx="60" cy="12" r="8" fill="var(--wb-color-primary)" />
        <path d="M57 12l2.2 2.2L63 10.4" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        {/* 猫耳 */}
        <path d="M18 26L22 10l14 10z" fill="#2B2B2B"/>
        <path d="M54 26L50 10L36 20z" fill="#2B2B2B"/>
        {/* 头 */}
        <rect x="16" y="20" width="40" height="40" rx="12" fill="#1F1F1F"/>
        {/* 眼睛（绿） */}
        <circle cx="29" cy="38" r="4" fill="var(--wb-color-primary)"/>
        <circle cx="43" cy="38" r="4" fill="var(--wb-color-primary)"/>
        {/* 嘴 */}
        <path d="M30 48h12" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"/>
      </svg>
    </div>
  );
}
