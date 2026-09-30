async function loadRemoteData(): Promise<string> {
  return Promise.resolve('remote data');
}

export function executeTask(): void {
  loadRemoteData();
}
