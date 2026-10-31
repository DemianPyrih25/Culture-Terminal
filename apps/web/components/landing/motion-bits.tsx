"use client";

import { MotionConfig, motion, useScroll, useTransform, type Variants } from "motion/react";
import { useId, useRef, useState, type ReactNode } from "react";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

/**
 * Motion for the landing: a short fade and rise as a block scrolls into view (once), staggered lists,
 * a light parallax on the hero visual and an animated question list. Under reduced motion the
 * MotionConfig drops every transform and keeps only the fades; the hero entrance is plain CSS
 * (animate-rise), which the global reduced-motion rule already stops.
 */

const EASE = [0.22, 1, 0.36, 1] as const;
const VIEWPORT = { once: true, amount: 0.15 } as const;

export function LandingMotion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

export function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "li" | "article";
}) {
  const Comp = as === "li" ? motion.li : as === "article" ? motion.article : motion.div;
  return (
    <Comp
      className={className}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={VIEWPORT}
      transition={{ duration: 0.45, ease: EASE, delay }}
    >
      {children}
    </Comp>
  );
}

const LIST: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } } };
const ITEM: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.36, ease: EASE } },
};

/** A list whose items rise in one after another the first time it scrolls into view. */
export function RevealList({
  children,
  className,
  as = "ul",
  label,
}: {
  children: ReactNode;
  className?: string;
  as?: "ul" | "ol" | "dl" | "div";
  label?: string;
}) {
  const Comp = as === "ol" ? motion.ol : as === "dl" ? motion.dl : as === "div" ? motion.div : motion.ul;
  return (
    <Comp
      aria-label={label}
      className={className}
      variants={LIST}
      initial="hidden"
      whileInView="show"
      viewport={VIEWPORT}
    >
      {children}
    </Comp>
  );
}

export function RevealItem({
  children,
  className,
  as = "li",
}: {
  children: ReactNode;
  className?: string;
  as?: "li" | "div";
}) {
  const Comp = as === "div" ? motion.div : motion.li;
  return (
    <Comp className={className} variants={ITEM}>
      {children}
    </Comp>
  );
}

/**
 * The hero product visual: drifts up a little slower than the page. Its entrance is CSS so the
 * image (the largest paint) is never held back waiting for hydration.
 */
export function HeroParallax({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [28, -28]);
  return (
    <div ref={ref} className={className}>
      <motion.div style={{ y }}>{children}</motion.div>
    </div>
  );
}

/** The questions list: one open at a time, the answer opens with height and opacity. */
export function Faq({ items }: { items: readonly { q: string; a: string }[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const base = useId();
  return (
    <RevealList as="div" className="border-t-2 border-ink">
      {items.map((f, i) => {
        const isOpen = open === i;
        const panel = `${base}-a${i}`;
        return (
          <RevealItem as="div" key={f.q} className="border-b border-line">
            <h3>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panel}
                onClick={() => setOpen(isOpen ? null : i)}
                className="group flex w-full cursor-pointer items-center justify-between gap-6 py-5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="font-display text-[19px] transition-colors duration-150 group-hover:text-accent sm:text-[21px]">
                  {f.q}
                </span>
                <Icon
                  name="chevron-down"
                  size={18}
                  className={cx(
                    "shrink-0 text-ink-3 transition-transform duration-200 ease-out",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
            </h3>
            <motion.div
              id={panel}
              role="region"
              aria-hidden={!isOpen}
              inert={!isOpen}
              initial={false}
              animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
              transition={{ duration: 0.24, ease: EASE }}
              className="overflow-hidden"
            >
              <p className="max-w-[680px] pb-6 text-[15px] leading-relaxed text-ink-2">{f.a}</p>
            </motion.div>
          </RevealItem>
        );
      })}
    </RevealList>
  );
}
