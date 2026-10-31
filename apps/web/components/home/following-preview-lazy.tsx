"use client";

import dynamic from "next/dynamic";

/**
 * Home's Following section, loaded after the page: the follows client brings zod, which stays out of
 * Home's first bundle (test/bundle/client-imports.test.ts).
 */
export const FollowingPreviewLazy = dynamic(() => import("./following-preview").then((m) => m.FollowingPreview), { ssr: false });
