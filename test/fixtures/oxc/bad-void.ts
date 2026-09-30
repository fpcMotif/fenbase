async function backgroundOperation(): Promise<void> {
  await Promise.resolve('completed');
}

export function triggerTask(): void {
  void backgroundOperation();
}
