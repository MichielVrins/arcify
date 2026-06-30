const REORDER_ITEM_SELECTOR = '[data-reorder-key]';
const REORDER_DURATION_MS = 180;

function capturePositions(): Map<string, DOMRect> {
  return new Map(
    Array.from(
      document.querySelectorAll<HTMLElement>(REORDER_ITEM_SELECTOR),
      element => [
        element.dataset.reorderKey as string,
        element.getBoundingClientRect(),
      ],
    ),
  );
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

export async function animateReorder(
  commit: () => void | Promise<void>,
): Promise<void> {
  const previousPositions = capturePositions();
  await commit();
  await nextFrame();

  for (const element of document.querySelectorAll<HTMLElement>(
    REORDER_ITEM_SELECTOR,
  )) {
    const key = element.dataset.reorderKey;
    const previous = key ? previousPositions.get(key) : null;
    if (!previous) continue;

    const next = element.getBoundingClientRect();
    const x = previous.left - next.left;
    const y = previous.top - next.top;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;

    element.animate(
      [
        { transform: `translate(${x}px, ${y}px)` },
        { transform: 'translate(0, 0)' },
      ],
      {
        duration: REORDER_DURATION_MS,
        easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
      },
    );
  }
}
