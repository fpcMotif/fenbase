// Good fixture - Clean TypeScript and React code
import React, { useEffect, useState } from 'react';

export function GoodComponent(): React.ReactElement {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    const handleTick = (): void => {
      setCount((prev) => prev + 1);
    };
    handleTick();
  }, []);

  return <div>Count: {count}</div>;
}

export async function goodAsync(): Promise<string> {
  const result = await Promise.resolve('ok');
  return result;
}
