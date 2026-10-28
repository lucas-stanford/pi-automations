// Progressive enhancement only: the pages read and navigate without this file.
// It adds the theme toggle, Copy page, code copy buttons, search and the "On this page" highlight.
(function () {
  "use strict";

  var root = document.documentElement;
  var THEME_KEY = "aa-theme";

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy") ? resolve() : reject(new Error("copy refused"));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  // ---- Theme ------------------------------------------------------------------------------
  function currentTheme() {
    var set = root.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  var toggle = document.querySelector(".theme-toggle");
  function labelToggle() {
    if (!toggle) return;
    toggle.setAttribute("aria-label", currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  if (toggle) {
    toggle.hidden = false;
    labelToggle();
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (e) {
        /* private mode: the choice lasts for this page only */
      }
      labelToggle();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      var onChange = function () {
        labelToggle();
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
    }
  }

  // ---- Copy page --------------------------------------------------------------------------
  var copyPage = document.querySelector(".copy-page");
  var source = document.getElementById("page-markdown");
  if (copyPage && source) {
    var markdown = "";
    try {
      markdown = JSON.parse(source.textContent || '""');
    } catch (e) {
      markdown = "";
    }
    if (markdown) {
      copyPage.hidden = false;
      var label = copyPage.querySelector(".copy-page-label");
      copyPage.addEventListener("click", function () {
        copyText(markdown).then(
          function () {
            label.textContent = "Copied";
            setTimeout(function () {
              label.textContent = "Copy page";
            }, 1600);
          },
          function () {
            label.textContent = "Copy failed";
            setTimeout(function () {
              label.textContent = "Copy page";
            }, 1600);
          },
        );
      });
    }
  }

  var menu = document.querySelector(".page-menu");
  if (menu) {
    document.addEventListener("click", function (e) {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    menu.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.open) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
    });
  }

  // ---- Code copy buttons ------------------------------------------------------------------
  var checkSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  Array.prototype.forEach.call(document.querySelectorAll(".copy-code"), function (button) {
    var code = button.parentNode.querySelector("pre code");
    if (!code) return;
    var original = button.innerHTML;
    button.hidden = false;
    button.addEventListener("click", function () {
      copyText(code.textContent || "").then(function () {
        button.innerHTML = checkSvg;
        button.classList.add("copied");
        button.setAttribute("aria-label", "Copied");
        setTimeout(function () {
          button.innerHTML = original;
          button.classList.remove("copied");
          button.setAttribute("aria-label", "Copy code");
        }, 1600);
      });
    });
  });

  // ---- On this page highlight -------------------------------------------------------------
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length > 0) {
    var targets = tocLinks
      .map(function (a) {
        return document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
      })
      .filter(Boolean);
    var ticking = false;
    var update = function () {
      ticking = false;
      var offset = 120;
      var active = 0;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top - offset <= 0) active = i;
        else break;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        active = targets.length - 1;
      }
      tocLinks.forEach(function (a, i) {
        var on = i === active;
        a.classList.toggle("active", on);
        if (on) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      });
    };
    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    update();
  }

  // ---- Search -----------------------------------------------------------------------------
  var input = document.getElementById("search-input");
  var results = document.getElementById("search-results");
  if (!input || !results) return;

  var kbd = document.querySelector(".search-kbd");
  if (kbd && /Mac|iPhone|iPad/.test(navigator.platform || "")) kbd.textContent = "⌘K";

  function index() {
    return window.__SEARCH_INDEX__ || [];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function terms(q) {
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(function (t) {
        return t.length > 0;
      });
  }

  function mark(text, words) {
    var html = escapeHtml(text);
    words.forEach(function (w) {
      var safe = escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(new RegExp("(" + safe + ")", "gi"), "<mark>$1</mark>");
    });
    return html;
  }

  function snippet(text, words) {
    var lower = text.toLowerCase();
    var at = -1;
    for (var i = 0; i < words.length && at < 0; i++) at = lower.indexOf(words[i]);
    if (at < 0) return text.slice(0, 140);
    var start = Math.max(0, at - 50);
    return (start > 0 ? "…" : "") + text.slice(start, start + 160) + (start + 160 < text.length ? "…" : "");
  }

  function search(q) {
    var words = terms(q);
    if (words.length === 0) return [];
    var scored = [];
    index().forEach(function (s) {
      var title = (s.h || s.p).toLowerCase();
      var page = s.p.toLowerCase();
      var text = s.x.toLowerCase();
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var hit = 0;
        if (title.indexOf(w) >= 0) hit += 10;
        if (page.indexOf(w) >= 0) hit += 3;
        if (text.indexOf(w) >= 0) hit += 1;
        if (hit === 0) return;
        score += hit;
      }
      if (title === q.toLowerCase().trim()) score += 20;
      scored.push({ s: s, score: score });
    });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.slice(0, 8).map(function (r) {
      return r.s;
    });
  }

  var selected = -1;
  function items() {
    return Array.prototype.slice.call(results.querySelectorAll(".search-result"));
  }
  function select(i) {
    var list = items();
    if (list.length === 0) return;
    selected = (i + list.length) % list.length;
    list.forEach(function (el, k) {
      el.setAttribute("aria-selected", k === selected ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", list[selected].id);
    list[selected].scrollIntoView({ block: "nearest" });
  }
  function close() {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    selected = -1;
  }
  function render() {
    var q = input.value;
    if (q.trim() === "") {
      close();
      return;
    }
    var words = terms(q);
    var found = search(q);
    if (found.length === 0) {
      results.innerHTML = '<p class="search-empty">No results for “' + escapeHtml(q.trim()) + "”</p>";
    } else {
      results.innerHTML = found
        .map(function (s, i) {
          var title = s.h
            ? mark(s.h, words) + ' <span class="search-result-page">· ' + escapeHtml(s.p) + "</span>"
            : mark(s.p, words);
          return (
            '<a class="search-result" role="option" aria-selected="false" id="search-result-' + i + '" href="' + escapeHtml(s.u) + '">' +
            '<span class="search-result-title">' + title + "</span>" +
            '<span class="search-result-text">' + mark(snippet(s.x, words), words) + "</span></a>"
          );
        })
        .join("");
    }
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
    selected = -1;
  }

  input.addEventListener("input", render);
  input.addEventListener("focus", function () {
    if (input.value.trim() !== "") render();
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === "Enter") {
      var list = items();
      var target = list[selected >= 0 ? selected : 0];
      if (target) {
        e.preventDefault();
        window.location.href = target.getAttribute("href");
      }
    } else if (e.key === "Escape") {
      if (input.value) input.value = "";
      close();
      input.blur();
    }
  });
  document.addEventListener("click", function (e) {
    if (!results.hidden && !results.contains(e.target) && e.target !== input) close();
  });
  document.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "") || (e.target && e.target.isContentEditable);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === "/" && !typing) {
      e.preventDefault();
      input.focus();
    }
  });
})();
