/* DOM tests only. Playback codecs/fullscreen/layout need real-browser and live Storage acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("catalog timeout");
}
for (const file of ["index.html", "ai-subscriptions.html"])
  test(
    file +
      ": database catalog feeds Persian calculator, disabled tariffs and in-page video controls",
    async (t) => {
      const errors = [],
        console = new VirtualConsole();
      console.on("jsdomError", (e) => errors.push(e.message));
      const dom = new JSDOM(read(file), {
        runScripts: "outside-only",
        url: "https://gptyar-web.github.io/",
        virtualConsole: console,
      });
      t.after(() => dom.window.close());
      const w = dom.window;
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new w.Event("close"));
      };
      w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLMediaElement.prototype.load = () => {};
      w.AbortSignal = AbortSignal;
      const catalog = {
        currency: "IRR",
        mode: "test",
        pricing: [
          {
            unit: "day",
            unit_price_rial: 400000,
            min_quantity: 1,
            max_quantity: 30,
            enabled: true,
          },
          {
            unit: "month",
            unit_price_rial: 11000000,
            min_quantity: 1,
            max_quantity: 2,
            enabled: false,
          },
        ],
        videos: [
          {
            slug: "android",
            title: "فیلم آزمایش DOM",
            description: "این fixture جایگزین فیلم واقعی نیست.",
            url: "https://fixture.supabase.co/video.mp4",
            sort_order: 1,
          },
        ],
      };
      w.fetch = async () => new Response(JSON.stringify(catalog));
      for (const s of w.document.querySelectorAll("script:not([src])"))
        w.eval(s.textContent);
      w.eval(
        "window.GPTYAR_COMMERCE_CONFIG={API_BASE_URL:'https://fixture.supabase.co/functions/v1/gptyar-api'}",
      );
      w.eval(read("assets/js/catalog.js"));
      await until(() => w.GPTYAR_CATALOG);
      w.document.querySelector('[data-provider="chatgpt"]').click();
      const quantity = w.document.getElementById("quantity");
      quantity.value = "۲";
      quantity.dispatchEvent(new w.Event("input"));
      assert.equal(
        w.document.getElementById("totalRial").textContent,
        "۸۰۰٬۰۰۰",
      );
      assert(w.document.querySelector('[data-cycle="month"]').disabled);
      assert.equal(
        w.document.getElementById("sharedOrder").href,
        "https://ble.ir/gpryarbot?start=buy",
      );
      const guide = w.document.querySelector('[data-activation="android"]');
      guide.dispatchEvent(
        new w.MouseEvent("click", { cancelable: true, bubbles: true }),
      );
      const dialog = w.document.querySelector(".video-dialog"),
        video = dialog.querySelector("video");
      assert(dialog.open);
      assert(video.controls);
      assert(video.playsInline);
      assert.equal(video.src, catalog.videos[0].url);
      assert.equal(w.document.querySelectorAll("video").length, 1);
      assert.equal(errors.length, 0, errors.join("\n"));
    },
  );
test("missing backend config never displays a fabricated current price", async (t) => {
  const dom = new JSDOM(read("index.html"), {
    runScripts: "outside-only",
    url: "https://gptyar-web.github.io/",
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  for (const s of w.document.querySelectorAll("script:not([src])"))
    w.eval(s.textContent);
  assert.equal(w.document.getElementById("totalRial").textContent, "—");
});
