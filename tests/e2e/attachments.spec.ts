import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("attachments: upload via button and drag-drop, visible to others", async ({ browser }) => {
  const alice = await register(browser, "att_a");
  const code = await createServer(alice, "Attach");
  const bob = await register(browser, "att_b");
  await joinServer(bob, code);

  // Button upload of an image + caption.
  await alice.locator('input[type="file"]').setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
  await expect(alice.locator('[data-upload="done"]')).toHaveCount(1);
  await alice.getByPlaceholder("Message #general").fill("look at this");
  await alice.keyboard.press("Enter");
  await expect(bob.getByText("look at this")).toBeVisible();
  const img = bob.locator('img[alt="pixel.png"]');
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);

  // Clicking opens the viewer, which links to the original.
  await img.click();
  const viewer = bob.getByTestId("image-viewer");
  await expect(viewer.getByText("pixel.png")).toBeVisible();
  const original = viewer.getByRole("link", { name: "Open original" });
  expect(await original.getAttribute("href")).toMatch(/^https?:\/\/.+\/api\/attachments\/\d+\/[\w-]+\/pixel\.png$/);
  await bob.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  // Drag-and-drop a non-media file; sent without text.
  const dt = await alice.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(["hello world"], "notes.txt", { type: "text/plain" }));
    return d;
  });
  // Dropped onto the chat column (bubbles to its drop handler).
  await alice.getByPlaceholder("Message #general").dispatchEvent("drop", { dataTransfer: dt });
  await expect(alice.getByText("notes.txt").first()).toBeVisible();
  await expect(alice.locator('[data-upload="done"]')).toHaveCount(1);
  await alice.getByPlaceholder("Message #general").press("Enter");
  const link = bob.getByRole("link", { name: /notes\.txt/ });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  const res = await bob.request.get(href!);
  expect(await res.text()).toBe("hello world");
  expect(res.headers()["content-disposition"]).toContain("attachment");
});

test("attachments: files over the server's limit are refused with a clear error", async ({ browser }) => {
  const alice = await register(browser, "att_big");
  await createServer(alice, "Big");
  const big = Buffer.alloc(1024 * 1024 + 1);
  await alice.locator('input[type="file"]').setInputFiles({ name: "big.mp4", mimeType: "video/mp4", buffer: big });
  await expect(alice.locator('[data-upload="error"]')).toContainText("limit is 1.0 MB");
  // And as a toast.
  await expect(alice.getByText("Couldn't upload big.mp4")).toBeVisible();

  // The server enforces it too, before reading the body.
  const res = await alice.evaluate(async () => {
    const { url: serverUrl, token } = JSON.parse(localStorage.getItem("sessions") ?? "{}").state?.sessions?.[0] ?? {};
    const channel = (location.hash || location.pathname).split("/").pop();
    const r = await fetch(`${serverUrl ?? ""}/api/channels/${channel}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-filename": "big.bin" },
      body: new Uint8Array(1024 * 1024 + 1),
    });
    return `${r.status} ${await r.text()}`;
  });
  expect(res).toMatch(/^413 /);
});
