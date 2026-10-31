"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Home's expanding blocks: each keyed child opens with height and opacity and closes the same way (220 ms).
 * What is there on the first render shows as it is (nothing animates on load or on re-render), and a
 * visitor who asks for reduced motion gets no motion at all.
 */
export function Expand({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

/** One block inside Expand: give it a stable key. */
export function ExpandItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ height: 0, opacity: 0, overflow: "hidden" }}
      animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
      transition={{ duration: reduce ? 0 : 0.22, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
