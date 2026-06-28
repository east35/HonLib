(function () {
  try {
    const theme = localStorage.getItem("ebook-library.theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    }
  } catch (_) {
    // Storage can be unavailable in private or restricted browsing contexts.
  }
})();
