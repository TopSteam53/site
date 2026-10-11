(function () {
  "use strict";

  var cfg;
  var form = document.getElementById("orderForm");
  var state = { vehicle: null, hours: 0, movers: 2 };

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
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(name, fallback) {
    var v = parseInt(form.elements[name].value, 10);
    return isNaN(v) ? fallback : v;
  }
  function val(name) { return form.elements[name].value.trim(); }
  function toast(text) {
    var t = $("#toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2600);
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
        var item = cfg.vehicles.concat(cfg.extras).filter(function (x) { return x.id === parts[0]; })[0];
        if (!item) return;
        if (parts[1] === "price" && !isNaN(n)) item.price = n;
        if (parts[1] === "available") item.available = yes.test(raw);
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

  // ---------- static texts ----------
  function bindTexts() {
    var round = cfg.ringRoad;
    var channels = [];
    if (cfg.telegram) channels.push("Telegram");
    if (cfg.max) channels.push("MAX");
    var texts = {
      name: cfg.name,
      tagline: cfg.tagline,
      phone: cfg.phone,
      city: cfg.city,
      cityLine: "Грузоперевозки · " + cfg.city + " и область",
      outsideLabel: "Км за " + round + " (если едем за город)",
      sendHint: channels.length
        ? "Нажмите «Написать в " + channels.join("» или «Написать в ") + "» — заявка скопируется, останется вставить её в чат и отправить."
        : "Позвоните, и мы всё уточним.",
      confirmHint: (cfg.ownerName ? cfg.ownerName : "Исполнитель") + " проверит адреса и подтвердит время и цену.",
    };
    $all("[data-bind]").forEach(function (el) {
      var v = texts[el.getAttribute("data-bind")];
      if (v != null) el.textContent = v;
    });
    $all('[data-bind-href="tel"]').forEach(function (el) {
      if (!cfg.phone) { el.hidden = true; return; }
      el.href = "tel:" + cfg.phone.replace(/[^\d+]/g, "");
    });
    document.title = cfg.name + " — грузоперевозки, " + cfg.city;
    document.documentElement.style.setProperty("--accent", cfg.accentColor);
    if (cfg.heroTitle) $(".hero__title").textContent = cfg.heroTitle;
    if (cfg.commentPlaceholder) form.elements.comment.placeholder = cfg.commentPlaceholder;
    if (cfg.noindex) {
      var robots = document.createElement("meta");
      robots.name = "robots"; robots.content = "noindex, nofollow";
      document.head.appendChild(robots);
    }

    var badges = [];
    if (cfg.rating) badges.push("★ " + cfg.rating + (cfg.reviewsCount ? " · " + cfg.reviewsCount + " " + plural(cfg.reviewsCount, "отзыв", "отзыва", "отзывов") + " на Авито" : ""));
    if (cfg.sinceYear) badges.push("Работаем с " + cfg.sinceYear + " года");
    badges = badges.concat(cfg.extraBadges || []);
    badges.push("Цена онлайн за минуту");
    $("#badges").innerHTML = badges.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("");
  }

  // ---------- fleet + choice ----------
  var truckSvg = '<svg viewBox="0 0 96 56" aria-hidden="true"><rect x="4" y="6" width="56" height="34" rx="4"/><path d="M60 16h16l14 14v10H60z"/><path class="win" d="M66 21h9l8 8H66z"/><circle cx="22" cy="44" r="8"/><circle cx="74" cy="44" r="8"/><circle class="hub" cx="22" cy="44" r="3"/><circle class="hub" cx="74" cy="44" r="3"/></svg>';

  function renderFleet() {
    $("#fleetList").innerHTML = cfg.vehicles.map(function (v) {
      var img = v.photo
        ? '<img src="' + esc(v.photo) + '" alt="' + esc(v.title) + '" loading="lazy">'
        : truckSvg;
      return '<article class="truck' + (v.available ? "" : " truck--busy") + '">' +
        '<div class="truck__pic">' + img + "</div>" +
        '<div class="truck__body"><h3>' + esc(v.title) + "</h3>" +
        "<p>" + esc(v.specs) + "</p>" +
        '<p class="truck__price">' + rub(v.price) + " / час</p>" +
        '<span class="tag ' + (v.available ? "tag--ok" : "tag--busy") + '">' + (v.available ? "Свободна" : "Сейчас занята") + "</span>" +
        "</div></article>";
    }).join("");

    var firstFree = cfg.vehicles.filter(function (v) { return v.available; })[0];
    if (!state.vehicle || !state.vehicle.available) state.vehicle = firstFree || null;

    $("#vehicleChoice").innerHTML = cfg.vehicles.map(function (v) {
      return '<label class="opt' + (v.available ? "" : " opt--off") + '">' +
        '<input type="radio" name="vehicle" value="' + esc(v.id) + '"' +
        (v.available ? "" : " disabled") +
        (state.vehicle && state.vehicle.id === v.id ? " checked" : "") + ">" +
        '<span class="opt__t">' + esc(v.title) + "</span>" +
        '<span class="opt__s">' + (v.available ? rub(v.price) + "/ч" : "занята") + "</span></label>";
    }).join("");

    var cargo = cfg.cargoTypes || [];
    $("#cargoField").hidden = !cargo.length;
    $("#cargoList").innerHTML = cargo.map(function (c, i) {
      return '<label class="chip"><input type="radio" name="cargo" value="' + esc(c) + '"' + (i === 0 ? " checked" : "") + "><span>" + esc(c) + "</span></label>";
    }).join("");

    $("#extrasList").innerHTML = (cfg.extras || []).map(function (x) {
      return '<label class="check"><input type="checkbox" name="extra" value="' + esc(x.id) + '">' +
        "<span>" + esc(x.title) + " <em>+" + rub(x.price) + "</em></span></label>";
    }).join("");
  }

  // ---------- calculation ----------
  function calc() {
    var lines = [], total = 0;
    var h = state.hours, m = state.movers;
    var v = state.vehicle;

    if (v) {
      var carHours = h + (cfg.supplyHours || 0);
      var car = v.price * carHours;
      lines.push([v.title + ": " + h + " ч" + (cfg.supplyHours ? " + " + cfg.supplyHours + " ч подача" : ""), car]);
      total += car;
    }
    if (m > 0) {
      var movers = cfg.moverPrice * m * h;
      lines.push(["Грузчики: " + m + " × " + h + " ч", movers]);
      total += movers;

      var floors = 0;
      if (!form.elements.liftFrom.checked) floors += Math.max(0, num("floorFrom", 1) - 1);
      if (!form.elements.liftTo.checked) floors += Math.max(0, num("floorTo", 1) - 1);
      if (floors > 0 && cfg.floorPrice) {
        lines.push(["Подъём/спуск без лифта: " + floors + " " + plural(floors, "этаж", "этажа", "этажей"), floors * cfg.floorPrice]);
        total += floors * cfg.floorPrice;
      }
    }
    var km = Math.max(0, num("outsideKm", 0));
    if (km > 0) {
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

  function selectedExtras() {
    var ids = $all('input[name="extra"]:checked').map(function (i) { return i.value; });
    return (cfg.extras || []).filter(function (x) { return ids.indexOf(x.id) >= 0; });
  }

  // ---------- message ----------
  function fmtDate(iso) {
    if (!iso) return "";
    var p = iso.split("-");
    return p[2] + "." + p[1] + "." + p[0];
  }
  function addrLine(addr, floor, lift) {
    var s = addr || "—";
    if (floor > 1) s += ", этаж " + floor + (lift ? ", лифт есть" : ", без лифта");
    return s;
  }

  function buildMessage(res) {
    var ex = selectedExtras().map(function (x) { return x.title; });
    var km = Math.max(0, num("outsideKm", 0));
    var out = [
      "Заявка с сайта «" + cfg.name + "»",
      "",
      "Машина: " + (state.vehicle ? state.vehicle.title : "—"),
      "Откуда: " + addrLine(val("from"), num("floorFrom", 1), form.elements.liftFrom.checked),
      "Куда: " + addrLine(val("to"), num("floorTo", 1), form.elements.liftTo.checked),
    ];
    if (km > 0) out.push("За " + cfg.ringRoad + ": " + km + " км");
    out.push("Дата: " + fmtDate(val("date")) + (val("time") ? ", подача в " + val("time") : ""));
    var cargo = form.querySelector('input[name="cargo"]:checked');
    if (cargo) out.push("Груз: " + cargo.value);
    out.push("Часов: " + state.hours + ", " + (state.movers ? "грузчиков: " + state.movers : "без грузчиков"));
    if (ex.length) out.push("Доп. услуги: " + ex.join(", "));
    if (val("comment")) out.push("Что везём: " + val("comment"));
    out.push("");
    out.push("Клиент: " + (val("clientName") || "—") + ", " + val("clientPhone"));
    out.push("Предварительно по калькулятору: ~" + rub(res.total));
    return out.join("\n");
  }

  // ---------- render ----------
  function update() {
    var res = calc();
    $("#estimateLines").innerHTML = res.lines.map(function (l) {
      return "<li><span>" + esc(l[0]) + "</span><b>" + rub(l[1]) + "</b></li>";
    }).join("");
    $("#estimateTotal").textContent = rub(res.total);
    $("#barTotal").textContent = rub(res.total);
    $("#hoursVal").textContent = state.hours + " ч";
    $("#moversVal").textContent = state.movers;
    $("#hoursHint").textContent = "Минимальный заказ — " + cfg.minHours + " " + plural(cfg.minHours, "час", "часа", "часов") +
      (cfg.supplyHours ? ", плюс " + cfg.supplyHours + " ч на подачу машины" : "") + ".";

    // Telegram умеет подставить текст в чат; MAX — нет, туда заявку вставляют из буфера
    var tg = $("#sendTg");
    if (tg) tg.href = "https://t.me/" + cfg.telegram.replace(/^@/, "") + "?text=" + encodeURIComponent(buildMessage(res));
  }

  function renderSendButtons() {
    var html = "";
    if (cfg.telegram) html += '<a class="btn btn--primary btn--tg" id="sendTg" target="_blank" rel="noopener">Отправить в Telegram</a>';
    if (cfg.max) html += '<a class="btn btn--primary btn--max" id="sendMax" href="' + esc(cfg.max) + '" target="_blank" rel="noopener">Написать в MAX</a>';
    if (!html) html = '<p class="demo-note">Демо-версия: заявки пока никуда не отправляются. Подключим ваш Telegram или MAX за пару минут.</p>';
    if (cfg.phone) html += '<a class="btn btn--ghost" href="tel:' + esc(cfg.phone.replace(/[^\d+]/g, "")) + '">Позвонить</a>';
    $("#sendButtons").innerHTML = html;
  }

  function validate() {
    var missing = [];
    var checks = [["from", "откуда"], ["to", "куда"], ["date", "дату"], ["clientPhone", "телефон"]];
    $all(".field--bad").forEach(function (el) { el.classList.remove("field--bad"); });
    checks.forEach(function (c) {
      if (!val(c[0])) {
        missing.push(c[1]);
        form.elements[c[0]].closest(".field").classList.add("field--bad");
      }
    });
    var phoneDigits = val("clientPhone").replace(/\D/g, "");
    if (val("clientPhone") && phoneDigits.length < 10) {
      missing.push("телефон полностью");
      form.elements.clientPhone.closest(".field").classList.add("field--bad");
    }
    if (!state.vehicle) missing.push("машину");
    var err = $("#formError");
    if (missing.length) {
      err.textContent = "Укажите: " + missing.join(", ") + ".";
      err.hidden = false;
      var bad = $(".field--bad input");
      if (bad) bad.focus();
      return false;
    }
    err.hidden = true;
    return true;
  }

  // ---------- events ----------
  function wire() {
    form.addEventListener("input", update);
    form.addEventListener("change", function (e) {
      if (e.target.name === "vehicle") {
        state.vehicle = cfg.vehicles.filter(function (v) { return v.id === e.target.value; })[0];
      }
      update();
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); });

    $all("[data-stepper]").forEach(function (box) {
      var key = box.getAttribute("data-stepper");
      box.addEventListener("click", function (e) {
        var b = e.target.closest("[data-step]");
        if (!b) return;
        var d = parseInt(b.getAttribute("data-step"), 10);
        if (key === "hours") state.hours = Math.min(cfg.maxHours, Math.max(cfg.minHours, state.hours + d));
        else state.movers = Math.min(cfg.maxMovers, Math.max(0, state.movers + d));
        update();
      });
    });

    $("#sendButtons").addEventListener("click", function (e) {
      var a = e.target.closest("#sendTg, #sendMax");
      if (!a) return;
      if (!validate()) { e.preventDefault(); return; }
      // Копируем всегда: в MAX текст не подставляется, в Telegram — подстраховка
      copyRequest(a.id === "sendMax"
        ? "Заявка скопирована — вставьте её в чат MAX и отправьте"
        : "Заявка скопирована на случай, если текст не подставился в чат");
    });

    $("#copyBtn").addEventListener("click", function () {
      if (validate()) copyRequest("Заявка скопирована — вставьте её в чат");
    });

    function copyRequest(message) {
      var text = buildMessage(calc());
      var done = function () { toast(message); };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallbackCopy);
      } else fallbackCopy();
      function fallbackCopy() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (_) { toast("Не удалось скопировать"); }
        ta.remove();
      }
    }

    // Нижняя плашка прячется, когда блок с расчётом на экране
    var bar = $("#bar");
    if ("IntersectionObserver" in window) {
      var hidden = { order: false, top: true };
      var sync = function () { bar.classList.toggle("bar--hidden", hidden.order || hidden.top); };
      new IntersectionObserver(function (es) {
        hidden.order = es[0].isIntersecting; sync();
      }).observe($("#estimate"));
      new IntersectionObserver(function (es) {
        hidden.top = es[0].isIntersecting; sync();
      }).observe($(".hero"));
    }
  }

  function initDate() {
    var d = new Date();
    var iso = function (x) {
      return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
    };
    form.elements.date.min = iso(d);
    d.setDate(d.getDate() + 1);
    form.elements.date.value = iso(d);
  }

  function render() {
    state.hours = Math.min(cfg.maxHours, Math.max(cfg.minHours, state.hours));
    state.movers = Math.min(cfg.maxMovers, state.movers);
    renderFleet();
    update();
  }

  // ---------- start ----------
  function start() {
    cfg = window.SITE_CONFIG;
    state.hours = cfg.minHours;
    state.movers = Math.min(cfg.defaultMovers != null ? cfg.defaultMovers : 2, cfg.maxMovers);
    bindTexts();
    if (!cfg.maxMovers) $('[data-stepper="movers"]').hidden = true;
    renderSendButtons();
    initDate();
    wire();
    render();
    loadSheet().then(render);
  }

  // Демо под конкретного клиента: index.html?c=vitaliy загружает clients/vitaliy.js
  var client = new URLSearchParams(location.search).get("c");
  if (client && /^[a-z0-9-]+$/.test(client)) {
    var s = document.createElement("script");
    s.src = "clients/" + client + ".js";
    s.onload = start;
    s.onerror = start;
    document.body.appendChild(s);
  } else {
    start();
  }
})();
