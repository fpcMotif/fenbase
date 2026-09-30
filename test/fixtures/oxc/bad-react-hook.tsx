import React, { useState } from 'react';

export function BadHookComponent({ condition }: { condition: boolean }): React.ReactElement {
  if (condition) {
    const [value] = useState<number>(100);
    return <div>{value}</div>;
  }
  return <div>Fallback</div>;
}
