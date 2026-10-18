/**
 * task-list feature store（左栏，§4.3）
 * 任务分组（进行中/已完成/规则任务）+ 工作空间授权 + 快捷操作
 */
import { create } from 'zustand';
import type { Task, TaskTrigger } from '@wdbuddy/shared-types';
import { requireApi } from '../../shared/ipc';

export type TaskGroup = 'active' | 'completed' | 'rules';

interface TaskListStore {
  tasks: Task[];
  loading: boolean;
  workspaces: string[];
  selectedTaskId: string | null;

  refresh(): Promise<void>;
  select(id: string): void;
  control(taskId: string, action: 'start' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject'): Promise<void>;
  remove(taskId: string): Promise<void>;
  rename(taskId: string, title: string): Promise<void>;
  addWorkspace(): Promise<void>;
  loadWorkspaces(): Promise<void>;
}

function groupOf(t: Task): TaskGroup {
  if (t.status === 'completed') return 'completed';
  if (t.trigger.type !== 'manual') return 'rules';
  return 'active';
}

export const useTaskListStore = create<TaskListStore>((set, get) => ({
  tasks: [],
  loading: false,
  workspaces: [],
  selectedTaskId: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const api = requireApi();
      const { tasks } = await api.taskList({ group: 'all' });
      set({ tasks });
    } finally {
      set({ loading: false });
    }
  },

  select: (id) => set({ selectedTaskId: id }),

  control: async (taskId, action) => {
    const api = requireApi();
    await api.taskControl({ taskId, action });
    await get().refresh();
  },

  remove: async (taskId) => {
    const api = requireApi();
    await api.taskDelete(taskId);
    await get().refresh();
  },

  rename: async (taskId, title) => {
    const api = requireApi();
    await api.taskRename(taskId, title);
    await get().refresh();
  },

  addWorkspace: async () => {
    const api = requireApi();
    await api.workspaceGrant();
    await get().loadWorkspaces();
  },

  loadWorkspaces: async () => {
    const api = requireApi();
    const s = await api.settingsGet();
    set({ workspaces: s.workspaces });
  },
}));

/** 分组视图（§4.3：进行中默认展开，其余折叠显示计数） */
export function groupTasks(tasks: Task[]): Record<TaskGroup, Task[]> {
  const out: Record<TaskGroup, Task[]> = { active: [], completed: [], rules: [] };
  for (const t of tasks) out[groupOf(t)].push(t);
  return out;
}

/** 任务状态徽标文案（§4.3） */
export function taskBadge(t: Task): { text: string; tone: 'neutral' | 'running' | 'success' | 'warning' | 'danger' | 'info' } {
  switch (t.status) {
    case 'running': return { text: '执行中', tone: 'running' };
    case 'awaiting-approval': return { text: '待我确认 ⚠', tone: 'warning' };
    case 'paused': return { text: '已暂停', tone: 'neutral' };
    case 'completed': return { text: '已完成', tone: 'success' };
    case 'failed': return { text: '失败', tone: 'danger' };
    case 'cancelled': return { text: '已取消', tone: 'neutral' };
    case 'interrupted': return { text: '可恢复', tone: 'info' };
    case 'draft': return { text: '草稿', tone: 'neutral' };
    case 'planning': return { text: '规划中', tone: 'info' };
    default: return { text: t.status, tone: 'neutral' };
  }
}

export type { TaskTrigger };

/** 相对时间（WorkBuddy 图1：7天前 / 5天前 / 刚刚） */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  return `${Math.floor(months / 12)}年前`;
}

/** 按新旧分桶（WorkBuddy 图1：任务按时间排序展示；已完成折叠） */
export function groupByRecency(tasks: Task[]): { completed: Task[] } {
  const completed = tasks
    .filter((t) => t.status === 'completed')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { completed };
}

/** 任务状态绿点（活跃/失败/空闲） */
export function taskStatusDot(t: Task): string {
  if (t.status === 'running' || t.status === 'planning') return 'wb-sidebar__task-dot--green';
  if (t.status === 'failed') return 'wb-sidebar__task-dot--red';
  if (t.status === 'paused' || t.status === 'interrupted' || t.status === 'awaiting-approval') return 'wb-sidebar__task-dot--amber';
  return '';
}
