import type { ThemeConfig } from 'antd';

// Wrap pending buttons in this theme: with antd motion on, a very fast rejection can leave a Button's loading icon
// stuck (definition-15.md, "Stuck loading icon").
export const withoutMotion: ThemeConfig = { token: { motion: false } };

export async function runPendingAction<T>(
  setPending: (pending: boolean) => void,
  action: () => Promise<T>,
): Promise<T> {
  setPending(true);
  try {
    return await action();
  } finally {
    setPending(false);
  }
}
