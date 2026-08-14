import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner frame; the tick timer only runs while spinning. */
export function useSpinner(spinning: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!spinning) return;
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % FRAMES.length),
      140,
    );
    return () => clearInterval(timer);
  }, [spinning]);
  return FRAMES[frame] ?? "";
}
