import { expect, expectNoExamples, expectNoSideScroll, open, shot, test } from "./support";

// Home (design/redesign.pen N01, N02), /ask and Your answers (/briefs). The redesign shows no examples
// anywhere: no ready answers, no "Try" chips, no example suggestions while typing. The spend guard
// (support.ts) blocks and fails a preview or a run any of these pages sends on its own.

test("Home renders the hero, the question box and the how band", async ({ page }, testInfo) => {
  await open(page, "/");
  await expect(page).toHaveTitle(/Culture Terminal/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel("Your question")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get answer" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Your answers" })).toHaveAttribute("href", "/briefs");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/how-it-works");
  await expectNoExamples(page);
  await expectNoSideScroll(page);
  await shot(page, testInfo, "home");
});

test("typing offers no example questions, and sends nothing until asked", async ({ page }, testInfo) => {
  await open(page, "/");
  const field = page.getByLabel("Your question");
  // An invented name: the only suggestion a name gets is its own audience profile.
  await field.fill("Pinecone Soap Co.");
  await expect(field).toHaveValue("Pinecone Soap Co.");
  const options = page.getByRole("option");
  const count = await options.count();
  expect(count).toBeLessThanOrEqual(1);
  if (count === 1) await expect(options.first()).toContainText("Pinecone Soap Co.");
  await expectNoExamples(page);
  await shot(page, testInfo, "home-typing");
});

test("Ask opens on an empty question and sends nothing until asked", async ({ page }) => {
  // A question in the URL is previewed on arrival (a model call): the smoke never puts one there.
  await open(page, "/ask");
  const field = page.getByLabel("Your question");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");
  await field.fill("Who is the Pinecone Soap Co. audience?");
  await expect(field).toHaveValue("Who is the Pinecone Soap Co. audience?");
  await expectNoSideScroll(page);
});

test("Your answers lists only this browser's runs, and starts empty", async ({ page }, testInfo) => {
  // A fresh browser context remembers no run.
  await open(page, "/briefs");
  await expect(page).toHaveTitle(/^Your answers · Culture Terminal$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your answers" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "No answers yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask a question" })).toHaveAttribute("href", "/home#ask");
  await expectNoExamples(page);
  await expectNoSideScroll(page);
  await shot(page, testInfo, "your-answers-empty");
});
