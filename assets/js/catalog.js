(() => {
  "use strict";
  const base = String(
    window.GPTYAR_COMMERCE_CONFIG?.API_BASE_URL || "",
  ).replace(/\/+$/, "");
  const msg = (message) => {
    const e = document.getElementById("catalogStatus");
    if (e) e.textContent = message;
  };
  const safeURL = (value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  };
  const dialog = document.createElement("dialog");
  dialog.className = "video-dialog";
  dialog.setAttribute("aria-label", "پخش آموزش");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "بستن";
  close.className = "btn";
  const title = document.createElement("h2"),
    video = document.createElement("video"),
    description = document.createElement("p");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.style.width = "100%";
  dialog.append(close, title, video, description);
  document.body.append(dialog);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("[data-activation]");
    if (!link) return;
    event.preventDefault();
    const item = window.GPTYAR_CATALOG?.videos?.find(
      (v) => v.slug === link.dataset.activation,
    );
    if (!item || !safeURL(item.url)) {
      msg(
        "این آموزش هنوز بارگذاری نشده است. لطفاً از پشتیبانی راهنمایی بگیرید.",
      );
      return;
    }
    title.textContent = item.title;
    description.textContent = item.description;
    video.src = safeURL(item.url);
    video.poster = safeURL(item.poster) || "";
    dialog.showModal();
  });
  async function load() {
    if (!safeURL(base)) {
      msg(
        "تعرفه آنلاین پس از اتصال سامانه نمایش داده می‌شود؛ خرید و استعلام از ربات بله انجام می‌شود.",
      );
      return;
    }
    try {
      const r = await fetch(base + "/public/catalog", {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error("catalog");
      const d = await r.json();
      if (!Array.isArray(d.pricing) || d.currency !== "IRR")
        throw new Error("contract");
      window.GPTYAR_CATALOG = d;
      document.querySelectorAll("[data-rate]").forEach((e) => {
        const p = d.pricing.find((p) => p.unit === e.dataset.rate);
        e.textContent = p?.enabled
          ? new Intl.NumberFormat("fa-IR").format(p.unit_price_rial / 10)
          : "غیرفعال";
      });
      document.querySelectorAll("[data-cycle]").forEach((b) => {
        b.disabled = !d.pricing.find((p) => p.unit === b.dataset.cycle)
          ?.enabled;
      });
      const grid = document.querySelector(".tutorial-grid");
      document
        .querySelectorAll("[data-generated-guide]")
        .forEach((card) => card.remove());
      for (const item of d.videos) {
        if (
          [...document.querySelectorAll("[data-activation]")].some(
            (c) => c.dataset.activation === item.slug,
          )
        )
          continue;
        const card = document.createElement("a");
        card.className = "tutorial-card";
        card.href = "#activation";
        card.dataset.activation = item.slug;
        card.dataset.generatedGuide = "true";
        const copy = document.createElement("div");
        copy.className = "tutorial-copy";
        const h = document.createElement("h3");
        h.textContent = item.title;
        const p = document.createElement("p");
        p.textContent = item.description;
        copy.append(h, p);
        card.append(copy);
        grid?.append(card);
      }
      const cards = [...document.querySelectorAll("[data-activation]")];
      for (const card of cards) {
        const v = d.videos.find((v) => v.slug === card.dataset.activation);
        card.setAttribute(
          "aria-label",
          v ? "پخش " + v.title + " در همین صفحه" : "آموزش هنوز بارگذاری نشده",
        );
        const source = card.querySelector(".tutorial-source");
        if (source)
          source.textContent = v ? "پخش در سایت" : "در انتظار بارگذاری";
        if (v) {
          card.querySelector("h3").textContent = v.title;
          card.querySelector(".tutorial-poster")?.remove();
          if (v.poster && safeURL(v.poster)) {
            const img = document.createElement("img");
            img.src = v.poster;
            img.alt = "";
            img.loading = "lazy";
            img.className = "tutorial-poster";
            card.prepend(img);
          }
          card.style.order = String(v.sort_order);
        }
      }
      msg(
        d.mode === "test"
          ? "ربات در حالت آزمایشی است؛ حساب واقعی صادر نمی‌شود."
          : "تعرفه به‌روز سامانه؛ مبلغ نهایی و تخفیف در ربات تأیید می‌شود. هر ماه دقیقاً ۳۰ روز است.",
      );
      window.dispatchEvent(new CustomEvent("gptyar:catalog", { detail: d }));
    } catch {
      msg(
        "دریافت تعرفه آنلاین ممکن نشد. برای قیمت معتبر و موجودی به ربات بله مراجعه کنید.",
      );
    }
  }
  load();
  // Refresh signed media URLs and current prices during long visits.
  setInterval(() => {
    if (document.visibilityState === "visible" && !dialog.open) load();
  }, 10 * 60000);
})();
