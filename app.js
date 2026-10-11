(function () {
  "use strict";

  var cfg;
  var client = new URLSearchParams(location.search).get("c");
  if (client && !/^[a-z0-9-]+$/.test(client)) client = null;
  var form = document.getElementById("orderForm");
  var state = { vehicle: null, hours: 0, movers: 2 };
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var isMobile = window.matchMedia("(max-width: 1023px)");

  // ---------- helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function rub(n) { return Math.round(n).toLocaleString("ru-RU") + " ₽"; }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function hoursWord(n) { return n + " " + plural(n, "час", "часа", "часов"); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function val(name) { return form.elements[name].value.trim(); }
  // Число из поля с учётом min/max; пустое или мусор — fallback
  function num(name, fallback) {
    var el = form.elements[name];
    var v = parseInt(el.value, 10);
    if (isNaN(v)) return fallback;
    var min = el.min !== "" ? Number(el.min) : -Infinity;
    var max = el.max !== "" ? Number(el.max) : Infinity;
    return Math.min(max, Math.max(min, v));
  }
  function telHref(phone) { return "tel:" + phone.replace(/[^\d+]/g, ""); }
  function icon(id) { return '<svg aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  var toastTimer;
  function toast(text) {
    var t = $("#toast");
    t.textContent = text;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, 2800);
  }

  // Плавная смена цены
  function animateNumber(el, to) {
    var from = el._value == null ? to : el._value;
    el._value = to;
    cancelAnimationFrame(el._raf);
    if (from === to || reduceMotion.matches) { el.textContent = rub(to); return; }
    var start = null, dur = 400;
    function step(ts) {
      if (start === null) start = ts;
      var k = Math.min(1, (ts - start) / dur);
      el.textContent = rub(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) el._raf = requestAnimationFrame(step);
    }
    el._raf = requestAnimationFrame(step);
  }

  // ---------- статус и смена машины ----------
  var STATUS = { free: "Свободна", busy: "Занята", confirm: "Требует подтверждения" };
  function vStatus(v) { return v.status || (v.available === false ? "busy" : "free"); }
  function selectable(v) { return vStatus(v) !== "busy"; }
  function minHoursFor(v) { return (v && v.minHours) || cfg.minHours; }

  // ---------- правки владельца из панели (хранятся в этом браузере) ----------
  var OWNER_KEY = "gazel-owner:" + (client || "default");
  function applyOwnerEdits() {
    var data;
    try { data = JSON.parse(localStorage.getItem(OWNER_KEY) || "null"); } catch (_) { data = null; }
    if (!data) return;
    cfg.vehicles.forEach(function (v) {
      var e = data.vehicles && data.vehicles[v.id];
      if (!e) return;
      if (e.price > 0) v.price = e.price;
      if (e.minHours > 0) v.minHours = e.minHours;
      if (STATUS[e.status]) v.status = e.status;
    });
    ["telegram", "max", "phone"].forEach(function (k) { if (typeof data[k] === "string" && data[k]) cfg[k] = data[k]; });
  }

  // ---------- Google Sheet overrides ----------
  // Таблица из двух колонок: ключ | значение. Примеры ключей:
  //   g4.price = 1600, g4.available = нет, moverPrice = 650, pack.price = 1200
  function parseCsv(text) {
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function applyOverrides(rows) {
    var yes = /^(да|yes|true|1|свободн)/i;
    rows.forEach(function (r) {
      var key = (r[0] || "").trim(), raw = (r[1] || "").trim();
      if (!key || !raw) return;
      var n = parseFloat(raw.replace(/\s/g, "").replace(",", "."));
      var parts = key.split(".");
      if (parts.length === 2) {
        var item = cfg.vehicles.concat(cfg.extras || []).filter(function (x) { return x.id === parts[0]; })[0];
        if (!item) return;
        if (parts[1] === "price" && !isNaN(n)) item.price = n;
        if (parts[1] === "available") { item.available = yes.test(raw); delete item.status; }
      } else if (typeof cfg[key] === "number" && !isNaN(n)) {
        cfg[key] = n;
      }
    });
  }

  function loadSheet() {
    if (!cfg.sheetCsvUrl) return Promise.resolve();
    var url = cfg.sheetCsvUrl + (cfg.sheetCsvUrl.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (t) { applyOverrides(parseCsv(t)); })
      .catch(function (e) { console.warn("Не удалось загрузить таблицу цен, используются цены из config.js", e); });
  }

  // ---------- тексты ----------
  function minPrice() {
    var free = cfg.vehicles.filter(selectable);
    var list = free.length ? free : cfg.vehicles;
    return Math.min.apply(null, list.map(function (v) { return v.price; }));
  }

  var starSvg = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z"/></svg>';
  function stars(n) { return new Array(n + 1).join(starSvg); }

  function bindTexts() {
    var texts = {
      name: cfg.name,
      brandSub: "Грузоперевозки · " + cfg.city,
      heroEyebrow: "Грузоперевозки · " + cfg.city + " и область",
      tagline: cfg.tagline,
      phone: cfg.phone,
      city: cfg.city,
      outsideLabel: "Км за " + cfg.ringRoad + ", если едем за город",
    };
    $all("[data-bind]").forEach(function (el) {
      var v = texts[el.getAttribute("data-bind")];
      if (v != null) el.textContent = v;
    });
    $all("[data-tel]").forEach(function (el) {
      el.hidden = !cfg.phone;
      if (!cfg.phone) return;
      el.href = telHref(cfg.phone);
      if (!el.textContent.trim()) el.textContent = cfg.phone;
      el.setAttribute("aria-label", "Позвонить: " + cfg.phone);
    });

    var title = cfg.name + " — грузоперевозки, " + cfg.city;
    document.title = title;
    var desc = document.querySelector('meta[name="description"]');
    if (desc && cfg.tagline) desc.content = cfg.tagline;
    var og = document.querySelector('meta[property="og:title"]');
    if (og) og.content = title;

    if (cfg.accentColor) document.documentElement.style.setProperty("--accent", cfg.accentColor);
    if (cfg.commentPlaceholder) form.elements.comment.placeholder = cfg.commentPlaceholder;
    if (cfg.noindex) {
      var robots = document.createElement("meta");
      robots.name = "robots"; robots.content = "noindex, nofollow";
      document.head.appendChild(robots);
    }

    $("#heroTitle").textContent = cfg.heroTitle || (cfg.maxMovers ? "Газель с грузчиками" : "Грузоперевозки на Газели");
    $("#moverRate").textContent = cfg.maxMovers ? rub(cfg.moverPrice) + " / час за человека" : "";
    $("#moversField").hidden = !cfg.maxMovers;
    $("#estimateNote").textContent = "Оплата — по фактическому времени. Точную сумму " +
      (cfg.ownerName || "исполнитель") + " подтвердит после проверки адресов.";
    $("#fleetAside").textContent = cfg.vehicles.length > 1
      ? "Цены за час работы машины с водителем. Минимальная смена указана в карточке."
      : "Цена за час работы машины с водителем.";

    var areas = cfg.areas ? "Выезд: " + cfg.areas : "";
    $("#areas").textContent = areas;
    $("#areas").hidden = !areas;
    $("#footAreas").textContent = areas || cfg.city;

    if (cfg.ownerName) {
      $("#seller").hidden = false;
      $("#sellerAva").textContent = cfg.ownerName.charAt(0);
      $("#sellerName").textContent = cfg.ownerName;
      $("#sellerNote").textContent = cfg.sellerNote || "";
      $("#sellerNote").hidden = !cfg.sellerNote;
    }

    var rating = $("#rating");
    if (cfg.rating) {
      rating.hidden = false;
      rating.innerHTML = '<span class="rating__stars">' + stars(5) + "</span><b>" + esc(cfg.rating) + "</b>" +
        (cfg.reviewsCount ? "<u>" + cfg.reviewsCount + " " + plural(cfg.reviewsCount, "отзыв", "отзыва", "отзывов") + " на Авито</u>" : "");
      if (cfg.reviewsUrl) { rating.href = cfg.reviewsUrl; rating.target = "_blank"; rating.rel = "noopener"; }
      else if ((cfg.reviews || []).length) rating.href = "#reviews";
      else rating.removeAttribute("href");

      var top = $("#topRating");
      top.hidden = false;
      top.innerHTML = starSvg + esc(cfg.rating) + (cfg.reviewsCount ? " <small>· " + cfg.reviewsCount + "</small>" : "");
      top.setAttribute("aria-label", "Рейтинг " + cfg.rating + (cfg.reviewsCount ? ", " + cfg.reviewsCount + " " + plural(cfg.reviewsCount, "отзыв", "отзыва", "отзывов") : ""));
      if (rating.hasAttribute("href")) { top.href = rating.href; if (cfg.reviewsUrl) { top.target = "_blank"; top.rel = "noopener"; } }
    }

    var perks = cfg.perks || [];
    $("#perks").hidden = !perks.length;
    $("#perks").innerHTML = perks.map(function (p) { return "<li>" + icon("check") + "<span>" + esc(p) + "</span></li>"; }).join("");

    $("#finalSub").textContent = (cfg.telegram || cfg.max)
      ? "Пришлите фото вещей или опишите груз — " + (cfg.ownerName || "исполнитель") + " подскажет и посчитает точно."
      : "Опишите груз в калькуляторе выше — подскажем машину и посчитаем точно.";
  }

  // ---------- первый экран, условия, вопросы ----------
  function galleryPhotos() {
    if (cfg.gallery && cfg.gallery.length) return cfg.gallery;
    if (cfg.heroPhoto) return [{ src: cfg.heroPhoto, alt: cfg.heroPhotoAlt || cfg.name }];
    return cfg.vehicles.filter(function (v) { return v.photo; }).map(function (v) { return { src: v.photo, alt: v.title }; });
  }

  function renderHero() {
    var hourPrice = minPrice();
    var first = cfg.vehicles.filter(selectable)[0] || cfg.vehicles[0];
    var minH = minHoursFor(first);
    var minText = "минимальная смена — " + hoursWord(minH) + (cfg.supplyHours ? " + " + cfg.supplyHours + " ч подача" : "");
    if (cfg.heroPriceMode === "order") {
      $("#heroPrice").textContent = "от " + rub(hourPrice * (minH + (cfg.supplyHours || 0)));
      $("#heroPriceUnit").textContent = "за заказ";
      $("#heroMin").textContent = rub(hourPrice) + " / час · " + minText;
    } else {
      $("#heroPrice").textContent = (cfg.vehicles.length > 1 ? "от " : "") + rub(hourPrice);
      $("#heroPriceUnit").textContent = "/ час";
      $("#heroMin").textContent = minText;
    }

    var rows = (cfg.facts || []).slice();
    if (cfg.maxMovers) rows.push(["Грузчик", rub(cfg.moverPrice) + " / час"]);
    if (cfg.outsideKmPrice) rows.push(["За " + cfg.ringRoad, rub(cfg.outsideKmPrice) + " / км" + (cfg.outsideRoundTrip ? ", туда и обратно" : "")]);
    if (cfg.location) rows.push(["Где стоит машина", cfg.location]);
    $("#facts").innerHTML = rows.map(function (r) {
      return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>";
    }).join("");

    var body = cfg.body;
    var fits = cfg.fits || [];
    $("#bodyCard").hidden = !body && !fits.length;
    $("#bodySvg").style.display = body ? "" : "none";
    if (body) {
      $("#bodyLen").textContent = body.length || "";
      $("#bodyHeight").textContent = body.height || "";
      $("#bodyWidth").textContent = body.width ? "ширина " + body.width : "";
    }
    $("#fitsBox").hidden = !fits.length;
    $("#fits").innerHTML = fits.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("");

    renderFaq();
    renderGallery(galleryPhotos());
  }

  // Вопросы собираются из настроек: реальные цифры, а не общие слова
  function renderFaq() {
    var qa = [[
      "Как считается цена?",
      rub(minPrice()) + " за час работы машины" + (cfg.supplyHours ? " плюс " + cfg.supplyHours + " ч на подачу" : "") +
        ". Минимальная смена — " + hoursWord(minHoursFor(cfg.vehicles[0])) + ". " +
        (cfg.maxMovers ? "Грузчик — " + rub(cfg.moverPrice) + " в час за человека. " : "") +
        "Платите по фактическому времени: калькулятор показывает ориентир.",
    ]];
    if (cfg.outsideKmPrice) {
      qa.push(["Сколько стоит выезд за " + cfg.ringRoad + "?",
        rub(cfg.outsideKmPrice) + " за километр" + (cfg.outsideRoundTrip ? ", считаем дорогу туда и обратно" : "") + ". По городу — без доплат за километры."]);
    }
    if (cfg.maxMovers && cfg.floorPrice) {
      qa.push(["Что, если нет грузового лифта?",
        "Подъём или спуск без лифта — " + rub(cfg.floorPrice) + " за этаж на каждом адресе, когда работают грузчики. Первый этаж бесплатно."]);
    }
    qa.push(["Как оставить заявку?",
      (cfg.telegram || cfg.max)
        ? "Заполните расчёт и нажмите «Отправить заявку» — откроется готовое сообщение со всеми деталями. Останется отправить его в мессенджер."
        : "Заполните расчёт и нажмите «Отправить заявку» — появится готовый текст, его можно скопировать."]);
    (cfg.faq || []).forEach(function (f) { qa.push(f); });
    $("#faqList").innerHTML = qa.map(function (q) {
      return "<details><summary>" + esc(q[0]) + "</summary><p>" + esc(q[1]) + "</p></details>";
    }).join("");
  }

  function renderReviews() {
    var list = cfg.reviews || [];
    $("#reviews").hidden = !list.length;
    if (!list.length) return;
    $("#reviewsList").innerHTML = list.map(function (r) {
      return '<li class="review" data-reveal>' +
        '<span class="review__stars" aria-label="Оценка ' + (r.rating || 5) + ' из 5">' + stars(r.rating || 5) + "</span>" +
        '<p class="review__text">' + esc(r.text) + "</p>" +
        '<p class="review__meta">' + esc(r.author) + (r.date ? " · " + esc(r.date) : "") + "</p></li>";
    }).join("");
    var link = $("#reviewsLink");
    link.hidden = !cfg.reviewsUrl;
    if (cfg.reviewsUrl) link.href = cfg.reviewsUrl;
  }

  // ---------- галерея ----------
  var galleryIndex = 0;
  function renderGallery(photos) {
    var box = $("#gallery"), track = $("#galleryTrack"), thumbs = $("#galleryThumbs");
    box.hidden = !photos.length;
    if (!photos.length) return;
    var key = photos.map(function (p) { return p.src; }).join("|");
    if (track._key === key) return; // повторный render после загрузки таблицы
    track._key = key;
    box.classList.toggle("gallery--multi", photos.length > 1);
    track.innerHTML = photos.map(function (p, i) {
      return '<figure class="gallery__slide" aria-label="Фото ' + (i + 1) + " из " + photos.length + '">' +
        '<img src="' + esc(p.src) + '" alt="' + esc(p.alt || cfg.name) + '"' + (i ? ' loading="lazy"' : ' fetchpriority="high"') + ' decoding="async"></figure>';
    }).join("");
    thumbs.hidden = photos.length < 2;
    thumbs.innerHTML = photos.length < 2 ? "" : photos.map(function (p, i) {
      return '<button type="button" class="gallery__thumb" data-i="' + i + '" aria-label="Показать фото ' + (i + 1) + '"><img src="' + esc(p.src) + '" alt="" loading="lazy"></button>';
    }).join("");
    galleryIndex = 0;
    syncGallery(photos.length);
  }

  function syncGallery(count) {
    $("#galleryCount").textContent = count > 1 ? (galleryIndex + 1) + " / " + count : "";
    $("#galleryCount").hidden = count < 2;
    $("#galleryPrev").disabled = galleryIndex <= 0;
    $("#galleryNext").disabled = galleryIndex >= count - 1;
    $all(".gallery__thumb").forEach(function (t, i) { t.setAttribute("aria-current", i === galleryIndex ? "true" : "false"); });
  }

  function wireGallery() {
    var track = $("#galleryTrack");
    function count() { return track.children.length; }
    function go(i) {
      i = Math.max(0, Math.min(count() - 1, i));
      track.scrollTo({ left: i * track.clientWidth, behavior: reduceMotion.matches ? "auto" : "smooth" });
    }
    var raf;
    track.addEventListener("scroll", function () {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () {
        var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if (i !== galleryIndex) { galleryIndex = i; syncGallery(count()); }
      });
    }, { passive: true });
    $("#galleryPrev").addEventListener("click", function () { go(galleryIndex - 1); });
    $("#galleryNext").addEventListener("click", function () { go(galleryIndex + 1); });
    $("#galleryThumbs").addEventListener("click", function (e) {
      var t = e.target.closest(".gallery__thumb");
      if (t) go(parseInt(t.getAttribute("data-i"), 10));
    });
    track.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); go(galleryIndex - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); go(galleryIndex + 1); }
    });
    window.addEventListener("resize", function () { track.scrollLeft = galleryIndex * track.clientWidth; });
  }

  // ---------- парк, груз, доп. услуги ----------
  // Без фото показываем объём кузова крупной цифрой, а не картинку-иконку
  function vehicleBadge(v) {
    if (v.badge) return v.badge;
    var m = /(\d+(?:[.,]\d+)?)\s*м³/.exec(v.specs || "") || /(\d+(?:[.,]\d+)?)\s*м(?![а-яё])/i.exec(v.title || "");
    return m ? m[0] : "";
  }

  function renderFleet() {
    if (!state.vehicle || !selectable(state.vehicle)) state.vehicle = cfg.vehicles.filter(selectable)[0] || null;

    $("#vehicleChoice").innerHTML = cfg.vehicles.map(function (v) {
      var st = vStatus(v), can = selectable(v);
      var picked = state.vehicle && state.vehicle.id === v.id;
      var pic = v.photo
        ? '<img src="' + esc(v.photo) + '" alt="' + esc(v.title) + '" loading="lazy">'
        : '<span class="vcard__badge">' + esc(vehicleBadge(v)) + "</span>";
      var btn = !can
        ? '<button type="button" class="btn btn--ghost btn--block" disabled>Сейчас занята</button>'
        : picked
          ? '<button type="button" class="btn btn--dark btn--block" data-pick="' + esc(v.id) + '" role="radio" aria-checked="true">Машина выбрана ' + icon("check") + "</button>"
          : '<button type="button" class="btn btn--accent btn--block" data-pick="' + esc(v.id) + '" role="radio" aria-checked="false">Выбрать ' + icon("check") + "</button>";
      return '<article class="vcard' + (picked ? " is-selected" : "") + (can ? "" : " vcard--busy") + '">' +
        '<div class="vcard__pic">' + pic + '<span class="vcard__flag">Выбрано</span></div>' +
        '<div class="vcard__body">' +
          '<div class="vcard__row"><h3 class="vcard__title">' + esc(v.title) + '</h3><span class="status status--' + st + '">' + STATUS[st] + "</span></div>" +
          '<p class="vcard__desc">' + esc(v.desc || v.specs || "") + "</p>" +
          '<p class="vcard__price"><b>' + rub(v.price) + "</b><span>/ час · мин. смена — " + hoursWord(minHoursFor(v)) + "</span></p>" +
          btn +
        "</div></article>";
    }).join("");

    $("#vehicleSelect").innerHTML = cfg.vehicles.map(function (v) {
      var can = selectable(v);
      return '<option value="' + esc(v.id) + '"' + (can ? "" : " disabled") + (state.vehicle && state.vehicle.id === v.id ? " selected" : "") + ">" +
        esc(v.title) + " · " + rub(v.price) + "/ч" + (can ? "" : " (занята)") + "</option>";
    }).join("");
  }

  function renderOptions() {
    renderFleet();

    var cargo = cfg.cargoTypes || [];
    var cargoChecked = form.querySelector('input[name="cargo"]:checked');
    var cargoVal = cargoChecked ? cargoChecked.value : cargo[0];
    $("#cargoField").hidden = !cargo.length;
    $("#cargoList").innerHTML = cargo.map(function (c) {
      return '<label class="chip"><input type="radio" name="cargo" value="' + esc(c) + '"' + (c === cargoVal ? " checked" : "") + "><span>" + esc(c) + "</span></label>";
    }).join("");

    var picked = selectedExtras().map(function (x) { return x.id; });
    $("#extrasList").innerHTML = (cfg.extras || []).map(function (x) {
      return '<label class="check"><input type="checkbox" name="extra" value="' + esc(x.id) + '"' + (picked.indexOf(x.id) >= 0 ? " checked" : "") + ">" +
        '<span class="check__box" aria-hidden="true"></span>' +
        '<span class="check__text">' + esc(x.title) + "</span>" +
        '<span class="check__price">+' + rub(x.price) + "</span></label>";
    }).join("");
  }

  function pickVehicle(id) {
    var v = cfg.vehicles.filter(function (x) { return x.id === id; })[0];
    if (!v || !selectable(v)) return;
    state.vehicle = v;
    state.hours = Math.max(state.hours, minHoursFor(v));
    renderFleet();
    update();
  }

  function selectedExtras() {
    var ids = $all('input[name="extra"]:checked').map(function (i) { return i.value; });
    return (cfg.extras || []).filter(function (x) { return ids.indexOf(x.id) >= 0; });
  }

  // ---------- расчёт ----------
  function calc() {
    var lines = [], total = 0;
    var h = state.hours, m = state.movers, v = state.vehicle;

    if (v) {
      lines.push(["Машина", v.title]);
      lines.push(["Продолжительность", hoursWord(h) + (cfg.supplyHours ? " + " + cfg.supplyHours + " ч подача" : "")]);
      var car = v.price * (h + (cfg.supplyHours || 0));
      lines.push(["Стоимость аренды", car]);
      total += car;
    }
    if (m > 0) {
      var movers = cfg.moverPrice * m * h;
      lines.push(["Грузчики: " + m + " × " + h + " ч", movers]);
      total += movers;

      var floors = 0;
      if (!form.elements.liftFrom.checked) floors += num("floorFrom", 1) - 1;
      if (!form.elements.liftTo.checked) floors += num("floorTo", 1) - 1;
      if (floors > 0 && cfg.floorPrice) {
        lines.push(["Без лифта: " + floors + " " + plural(floors, "этаж", "этажа", "этажей"), floors * cfg.floorPrice]);
        total += floors * cfg.floorPrice;
      }
    }
    var km = num("outsideKm", 0);
    if (km > 0 && cfg.outsideKmPrice) {
      var kmTotal = km * (cfg.outsideRoundTrip ? 2 : 1);
      lines.push(["За " + cfg.ringRoad + ": " + kmTotal + " км", kmTotal * cfg.outsideKmPrice]);
      total += kmTotal * cfg.outsideKmPrice;
    }
    selectedExtras().forEach(function (x) {
      lines.push([x.title, x.price]);
      total += x.price;
    });
    return { lines: lines, total: total };
  }

  // ---------- текст заявки ----------
  function fmtDate(iso) {
    if (!iso) return "";
    var p = iso.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  }
  function addrLine(addr, floor, lift) {
    var s = addr || "—";
    if (floor > 1) s += ", этаж " + floor + (lift ? ", лифт есть" : ", без лифта");
    return s;
  }

  function buildMessage(res) {
    var ex = selectedExtras().map(function (x) { return x.title; });
    var km = num("outsideKm", 0);
    var out = [
      "Здравствуйте! Хочу заказать грузоперевозку.",
      "",
      "Машина: " + (state.vehicle ? state.vehicle.title : "—"),
      "Откуда: " + addrLine(val("from"), num("floorFrom", 1), form.elements.liftFrom.checked),
      "Куда: " + addrLine(val("to"), num("floorTo", 1), form.elements.liftTo.checked),
    ];
    if (km > 0) out.push("За " + cfg.ringRoad + ": " + km + " км");
    out.push("Дата: " + fmtDate(val("date")));
    if (val("time")) out.push("Время подачи: " + val("time"));
    out.push("Продолжительность: " + hoursWord(state.hours));
    out.push("Грузчики: " + (state.movers ? state.movers : "не нужны"));
    var cargo = form.querySelector('input[name="cargo"]:checked');
    if (cargo) out.push("Груз: " + cargo.value);
    if (ex.length) out.push("Доп. услуги: " + ex.join(", "));
    out.push("Рассчитанная стоимость: " + rub(res.total));
    if (val("comment")) out.push("Комментарий: " + val("comment"));
    out.push("");
    out.push("Контакт: " + (val("clientName") ? val("clientName") + ", " : "") + val("clientPhone"));
    return out.join("\n");
  }

  // ---------- отрисовка расчёта ----------
  function update() {
    var res = calc();
    $("#estimateLines").innerHTML = res.lines.length
      ? res.lines.map(function (l) {
          return "<li><span>" + esc(l[0]) + "</span><b>" + esc(typeof l[1] === "number" ? rub(l[1]) : l[1]) + "</b></li>";
        }).join("")
      : "<li><span>Все машины сейчас заняты — позвоните, подберём время</span></li>";
    animateNumber($("#estimateTotal"), res.total);
    animateNumber($("#barTotal"), res.total);

    var minH = minHoursFor(state.vehicle);
    $("#hoursVal").textContent = hoursWord(state.hours);
    $("#moversVal").textContent = state.movers ? state.movers : "нет";
    $('[data-stepper="hours"] [data-step="-1"]').disabled = state.hours <= minH;
    $('[data-stepper="hours"] [data-step="1"]').disabled = state.hours >= cfg.maxHours;
    $('[data-stepper="movers"] [data-step="-1"]').disabled = state.movers <= 0;
    $('[data-stepper="movers"] [data-step="1"]').disabled = state.movers >= cfg.maxMovers;
    $("#hoursHint").textContent = "Минимальная смена — " + hoursWord(minH) + (cfg.supplyHours ? ", подача +" + cfg.supplyHours + " ч" : "");
  }

  function sendLabel() {
    if (cfg.telegram) return "Отправить заявку в Telegram";
    if (cfg.max) return "Отправить заявку в MAX";
    return "Отправить заявку";
  }

  function renderFinal() {
    $("#sendBtnText").textContent = sendLabel();
    var fin = "";
    if (cfg.telegram) fin += '<a class="btn btn--accent btn--lg" href="https://t.me/' + esc(cfg.telegram.replace(/^@/, "")) + '" target="_blank" rel="noopener">' + icon("send") + " Написать в Telegram</a>";
    if (cfg.max) fin += '<a class="btn ' + (cfg.telegram ? "btn--ghost" : "btn--accent") + ' btn--lg" href="' + esc(cfg.max) + '" target="_blank" rel="noopener">Написать в MAX</a>';
    if (cfg.phone) fin += '<a class="btn btn--ghost btn--lg" href="' + esc(telHref(cfg.phone)) + '">' + icon("phone") + " Позвонить</a>";
    if (!fin) fin = '<a class="btn btn--accent btn--lg" href="#order" data-scroll>Перейти к расчёту ' + icon("arrow") + "</a>";
    $("#finalButtons").innerHTML = fin;
  }

  // ---------- окно предпросмотра заявки ----------
  var lastFocus = null;
  function openModal() {
    var text = buildMessage(calc());
    var tg = cfg.telegram && cfg.telegram.replace(/^@/, "");
    $("#modalText").textContent = text;
    $("#manualCopy").hidden = true;
    var app = $("#modalAppIcon");
    app.classList.toggle("modal__app--max", !tg && !!cfg.max);
    var actions = '<button type="button" class="btn btn--ghost" data-copy>' + icon("copy") + " Скопировать заявку</button>";
    if (tg) {
      $("#modalTitle").textContent = "Заявка для Telegram";
      $("#modalSub").textContent = "@" + tg;
      $("#modalHint").textContent = "";
      actions += '<a class="btn btn--accent" id="sendTg" href="https://t.me/' + esc(tg) + "?text=" + encodeURIComponent(text) + '" target="_blank" rel="noopener">' + icon("send") + " Открыть Telegram</a>";
      if (cfg.max) actions += '<a class="btn btn--ghost" id="sendMax" href="' + esc(cfg.max) + '" target="_blank" rel="noopener">Открыть MAX</a>';
    } else if (cfg.max) {
      $("#modalTitle").textContent = "Заявка для MAX";
      $("#modalSub").textContent = cfg.ownerName || cfg.name;
      $("#modalHint").textContent = "MAX не вставляет текст сам: заявка скопируется при открытии — вставьте её в чат.";
      actions += '<a class="btn btn--accent" id="sendMax" href="' + esc(cfg.max) + '" target="_blank" rel="noopener">' + icon("send") + " Открыть MAX</a>";
    } else {
      $("#modalTitle").textContent = "Ваша заявка";
      $("#modalSub").textContent = "Демо-версия";
      $("#modalHint").textContent = "Здесь откроется Telegram или MAX владельца — заявка придёт ему готовым сообщением.";
    }
    if (cfg.phone) actions += '<a class="btn btn--ghost" href="' + esc(telHref(cfg.phone)) + '">' + icon("phone") + " Позвонить</a>";
    $("#modalActions").innerHTML = actions;

    var modal = $("#modal");
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("is-modal");
    requestAnimationFrame(function () { modal.classList.add("is-open"); });
    $(".modal__close").focus();
  }

  function closeModal() {
    var modal = $("#modal");
    if (modal.hidden) return;
    modal.classList.remove("is-open");
    document.body.classList.remove("is-modal");
    setTimeout(function () { modal.hidden = true; }, reduceMotion.matches ? 0 : 250);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function wireModal() {
    var modal = $("#modal");
    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) { closeModal(); return; }
      if (e.target.closest("[data-copy]")) { copyRequest("Заявка скопирована — вставьте её в чат"); return; }
      var a = e.target.closest("#sendTg, #sendMax");
      if (a) {
        copyRequest(a.id === "sendMax"
          ? "Заявка скопирована — вставьте её в чат MAX и отправьте"
          : "Заявка скопирована на случай, если текст не подставился в чат");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (modal.hidden) return;
      if (e.key === "Escape") closeModal();
      if (e.key === "Tab") {
        var f = $all("button, a[href], textarea", modal).filter(function (el) { return el.offsetParent !== null && !el.disabled; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  // ---------- проверка формы ----------
  var REQUIRED = [
    ["from", "откуда", "Укажите адрес погрузки"],
    ["to", "куда", "Укажите адрес выгрузки"],
    ["date", "дату", "Выберите дату"],
    ["clientPhone", "телефон", "Укажите телефон"],
  ];

  function setFieldError(name, msg) {
    var box = form.querySelector('[data-field="' + name + '"]');
    var input = form.elements[name];
    if (!box) return;
    var errId = "err-" + name;
    var err = document.getElementById(errId);
    if (msg) {
      box.classList.remove("is-invalid");
      void box.offsetWidth; // перезапуск анимации
      box.classList.add("is-invalid");
      if (!err) {
        err = document.createElement("small");
        err.className = "field__err";
        err.id = errId;
        box.appendChild(err);
      }
      err.textContent = msg;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errId);
    } else {
      box.classList.remove("is-invalid");
      if (err) err.remove();
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function fieldProblem(name) {
    var v = val(name);
    var rule = REQUIRED.filter(function (r) { return r[0] === name; })[0];
    if (!v) return rule[2];
    if (name === "date" && v < todayIso()) return "Эта дата уже прошла";
    if (name === "clientPhone" && v.replace(/\D/g, "").length < 11) return "Введите номер полностью";
    return "";
  }

  function validate() {
    var missing = [], first = null;
    REQUIRED.forEach(function (r) {
      var problem = fieldProblem(r[0]);
      setFieldError(r[0], problem);
      if (problem) {
        missing.push(r[1]);
        if (!first) first = form.elements[r[0]];
      }
    });
    if (!state.vehicle) missing.push("машину");
    var err = $("#formError");
    if (missing.length) {
      err.textContent = "Заполните: " + missing.join(", ") + ".";
      err.hidden = false;
      if (first) {
        first.focus({ preventScroll: true });
        first.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "center" });
      }
      return false;
    }
    err.hidden = true;
    return true;
  }

  // ---------- маска телефона ----------
  function formatPhone(raw) {
    var d = raw.replace(/\D/g, "");
    if (!d) return "";
    if (d[0] === "8") d = "7" + d.slice(1);
    else if (d[0] !== "7") d = "7" + d;
    d = d.slice(0, 11);
    var out = "+7";
    if (d.length > 1) out += " (" + d.slice(1, 4);
    if (d.length > 4) out += ") " + d.slice(4, 7);
    if (d.length > 7) out += "-" + d.slice(7, 9);
    if (d.length > 9) out += "-" + d.slice(9, 11);
    return out;
  }

  function wirePhoneMask() {
    var input = form.elements.clientPhone;
    input.addEventListener("input", function () {
      var raw = input.value;
      var pos = input.selectionStart;
      var atEnd = pos === raw.length;
      var digitsBefore = raw.slice(0, pos).replace(/\D/g, "").length;
      var formatted = formatPhone(raw);
      if (formatted === raw) return;
      input.value = formatted;
      if (atEnd || document.activeElement !== input) return;
      var i = 0, seen = 0;
      while (i < formatted.length && seen < digitsBefore) { if (/\d/.test(formatted[i])) seen++; i++; }
      input.setSelectionRange(i, i);
    });
  }

  // ---------- копирование ----------
  function copyRequest(message) {
    var text = buildMessage(calc());
    var manual = $("#manualCopy");
    manual.hidden = true;
    function done() { toast(message); }
    function showManual() {
      $("#manualCopyText").value = text;
      manual.hidden = false;
      $("#manualCopyText").focus();
      $("#manualCopyText").select();
      toast("Не удалось скопировать автоматически — скопируйте текст вручную");
    }
    function legacyCopy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      ta.remove();
      if (ok) done(); else showManual();
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, legacyCopy);
    } else {
      legacyCopy();
    }
  }

  // ---------- события ----------
  function wire() {
    form.addEventListener("input", function (e) {
      var name = e.target.name;
      if (form.querySelector('[data-field="' + name + '"].is-invalid') && !fieldProblem(name)) setFieldError(name, "");
      update();
    });
    form.addEventListener("change", function (e) {
      if (e.target.name === "vehicleSelect") { pickVehicle(e.target.value); return; }
      if (e.target.name === "date" && form.querySelector('[data-field="date"].is-invalid')) setFieldError("date", fieldProblem("date"));
      update();
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); });

    $("#vehicleChoice").addEventListener("click", function (e) {
      var b = e.target.closest("[data-pick]");
      if (!b) return;
      pickVehicle(b.getAttribute("data-pick"));
      toast("Машина выбрана — укажите детали ниже");
    });

    // Числовые поля: без минуса, «e» и дробей; при уходе с поля — приводим к допустимому
    $all("[data-num]").forEach(function (el) {
      el.addEventListener("keydown", function (e) {
        if (["e", "E", "+", "-", ".", ","].indexOf(e.key) >= 0) e.preventDefault();
      });
      el.addEventListener("blur", function () {
        var fallback = el.min !== "" ? Number(el.min) : 0;
        el.value = num(el.name, fallback);
        update();
      });
    });

    $all("[data-stepper]").forEach(function (box) {
      var key = box.getAttribute("data-stepper");
      box.addEventListener("click", function (e) {
        var b = e.target.closest("[data-step]");
        if (!b || b.disabled) return;
        var d = parseInt(b.getAttribute("data-step"), 10);
        if (key === "hours") state.hours = Math.min(cfg.maxHours, Math.max(minHoursFor(state.vehicle), state.hours + d));
        else state.movers = Math.min(cfg.maxMovers, Math.max(0, state.movers + d));
        update();
      });
    });

    $("#sendBtn").addEventListener("click", function () {
      if (validate()) openModal();
    });

    // Плавный скролл по якорям
    document.addEventListener("click", function (e) {
      var a = e.target.closest("[data-scroll]");
      if (!a) return;
      var target = document.querySelector(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", a.getAttribute("href"));
    });

    wireBar();
    wireReveal();
    wirePhoneMask();
    wireGallery();
    wireModal();
  }

  // Нижняя панель: прячется, когда итог на экране или открыта клавиатура
  function wireBar() {
    var bar = $("#bar");
    var flags = { summary: false, typing: false };
    function sync() { bar.classList.toggle("bar--hidden", flags.summary || flags.typing); }
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) {
        flags.summary = es[0].isIntersecting; sync();
      }, { rootMargin: "0px 0px -80px 0px" }).observe($("#estimate"));
    }
    var typingInput = function (el) {
      return el && el.matches && el.matches("input, textarea, select") && !el.matches('[type="checkbox"], [type="radio"]');
    };
    document.addEventListener("focusin", function (e) {
      if (isMobile.matches && typingInput(e.target)) { flags.typing = true; sync(); }
    });
    document.addEventListener("focusout", function () {
      setTimeout(function () { flags.typing = typingInput(document.activeElement) && isMobile.matches; sync(); }, 50);
    });
  }

  function wireReveal() {
    var items = $all("[data-reveal]");
    if (!("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }

  function initDate() {
    var d = new Date();
    d.setDate(d.getDate() + 1);
    form.elements.date.min = todayIso();
    form.elements.date.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function render() {
    renderHero();
    renderOptions();
    state.hours = Math.min(cfg.maxHours, Math.max(minHoursFor(state.vehicle), state.hours));
    state.movers = Math.min(cfg.maxMovers, Math.max(0, state.movers));
    update();
  }

  // ---------- старт ----------
  function start() {
    cfg = window.SITE_CONFIG;
    applyOwnerEdits();
    state.hours = 0;
    state.movers = Math.min(cfg.defaultMovers != null ? cfg.defaultMovers : 2, cfg.maxMovers);
    bindTexts();
    renderReviews();
    renderFinal();
    initDate();
    wire();
    render();
    loadSheet().then(render);
  }

  // Демо под конкретного клиента: index.html?c=vitaliy загружает clients/vitaliy.js
  if (client) {
    var s = document.createElement("script");
    s.src = "clients/" + client + ".js";
    s.onload = start;
    s.onerror = start;
    document.body.appendChild(s);
  } else {
    start();
  }
})();
