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
