(function () {
  "use strict";

  // Панель владельца: меняет цену, минимальную смену, статус машин и контакты.
  // Правки хранятся в localStorage под тем же ключом, что читает app.js.
  var client = new URLSearchParams(location.search).get("c");
  if (client && !/^[a-z0-9-]+$/.test(client)) client = null;
  var KEY = "gazel-owner:" + (client || "default");
  var STATUS = { free: "Свободна", busy: "Занята", confirm: "Требует подтверждения" };
  var cfg, data;

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null") || { vehicles: {} }; } catch (_) { return { vehicles: {} }; }
  }
  var toastTimer;
  function toast(text) {
    var t = $("#toast");
    t.textContent = text;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, 1800);
  }
  function save(msg) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); toast(msg || "Сохранено"); }
    catch (_) { toast("Браузер не дал сохранить изменения"); }
  }

  function current(v) {
    var e = data.vehicles[v.id] || {};
    return {
      price: e.price || v.price,
      minHours: e.minHours || v.minHours || cfg.minHours,
      status: e.status || v.status || (v.available === false ? "busy" : "free"),
    };
  }

  function renderStats() {
    var c = { free: 0, busy: 0, confirm: 0 };
    cfg.vehicles.forEach(function (v) { c[current(v).status]++; });
    $("#statFree").textContent = c.free;
    $("#statBusy").textContent = c.busy;
    $("#statConfirm").textContent = c.confirm;
    var n = cfg.vehicles.length;
    $("#parkCount").textContent = "В парке: " + n + " " + (n === 1 ? "машина" : n < 5 ? "машины" : "машин");
  }

  function render() {
    $("#ownerVehicles").innerHTML = cfg.vehicles.map(function (v) {
      var c = current(v);
      var thumb = v.photo ? '<img src="' + esc(v.photo) + '" alt="">' : '<svg aria-hidden="true"><use href="#i-truck"/></svg>';
      return '<article class="card ocard" data-id="' + esc(v.id) + '">' +
        '<div class="ocard__head"><span class="ocard__thumb">' + thumb + "</span>" +
          '<div class="ocard__titles"><p class="ocard__eyebrow">Машина</p><h3 class="ocard__title">' + esc(v.title) + "</h3>" +
          '<p class="ocard__desc">' + esc(v.desc || v.specs || "") + "</p></div></div>" +
        '<div class="ocard__body"><div class="grid2">' +
          '<div class="field"><label for="p-' + esc(v.id) + '">Цена за час</label><div class="control">' +
            '<svg class="control__icon" aria-hidden="true"><use href="#i-ruble"/></svg>' +
            '<input id="p-' + esc(v.id) + '" type="number" inputmode="numeric" min="100" max="100000" step="50" value="' + c.price + '" data-k="price"></div></div>' +
          '<div class="field"><label for="m-' + esc(v.id) + '">Минимальная смена, ч</label><div class="control">' +
            '<svg class="control__icon" aria-hidden="true"><use href="#i-clock"/></svg>' +
            '<input id="m-' + esc(v.id) + '" type="number" inputmode="numeric" min="1" max="24" value="' + c.minHours + '" data-k="minHours"></div></div>' +
        "</div>" +
        '<p class="field__label">Статус машины</p>' +
        '<div class="seg" role="radiogroup" aria-label="Статус: ' + esc(v.title) + '">' +
          Object.keys(STATUS).map(function (s) {
            return '<button type="button" class="seg__btn seg__btn--' + s + '" role="radio" aria-checked="' + (c.status === s) + '" data-status="' + s + '">' + STATUS[s] + "</button>";
          }).join("") +
        "</div>" +
        (v.specs ? '<p class="ocard__model">' + esc(v.specs) + "</p>" : "") +
        "</div></article>";
    }).join("");
    renderStats();
  }

  function wire() {
    var grid = $("#ownerVehicles");
    grid.addEventListener("change", function (e) {
      var input = e.target.closest("[data-k]");
      if (!input) return;
      var id = input.closest("[data-id]").getAttribute("data-id");
      var n = parseInt(input.value, 10);
      var min = Number(input.min), max = Number(input.max);
      if (isNaN(n)) n = min;
      n = Math.min(max, Math.max(min, n));
      input.value = n;
      data.vehicles[id] = data.vehicles[id] || {};
      data.vehicles[id][input.getAttribute("data-k")] = n;
      save();
    });
    grid.addEventListener("click", function (e) {
      var b = e.target.closest("[data-status]");
      if (!b) return;
      var id = b.closest("[data-id]").getAttribute("data-id");
      data.vehicles[id] = data.vehicles[id] || {};
      data.vehicles[id].status = b.getAttribute("data-status");
      b.parentNode.querySelectorAll("[data-status]").forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); });
      renderStats();
      save("Статус обновлён");
    });

    [["#ownTelegram", "telegram"], ["#ownMax", "max"], ["#ownPhone", "phone"]].forEach(function (p) {
      var el = $(p[0]);
      el.value = data[p[1]] || cfg[p[1]] || "";
      el.addEventListener("change", function () {
        var v = el.value.trim();
        if (p[1] === "telegram") v = v.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");
        el.value = v;
        data[p[1]] = v;
        save();
      });
    });

    $("#ownerReset").addEventListener("click", function () {
      if (!confirm("Сбросить все изменения и вернуть исходные цены?")) return;
      try { localStorage.removeItem(KEY); } catch (_) {}
      data = { vehicles: {} };
      ["#ownTelegram", "#ownMax", "#ownPhone"].forEach(function (s, i) { $(s).value = cfg[["telegram", "max", "phone"][i]] || ""; });
      render();
      toast("Изменения сброшены");
    });
  }

  function start() {
    cfg = window.SITE_CONFIG;
    data = load();
    data.vehicles = data.vehicles || {};
    document.title = "Панель владельца — " + cfg.name;
    $("#ownerBrand").textContent = cfg.name;
    var href = "index.html" + (client ? "?c=" + client : "");
    $("#clientLink").href = href;
    $("#clientLink2").href = href;
    render();
    wire();
  }

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
