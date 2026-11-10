const themeRoot = document.documentElement;
const themeStorageKey = "debrid-canal-theme";

try {
  if (localStorage.getItem(themeStorageKey) === "light") {
    themeRoot.dataset.theme = "light";
  }
} catch {
  // The browser may block storage access.
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("theme-toggle");
  const updateLabel = () => {
    const label = themeRoot.dataset.theme === "light"
      ? "Switch to dark mode"
      : "Switch to light mode";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  };

  updateLabel();
  toggle.addEventListener("click", () => {
    const theme = themeRoot.dataset.theme === "light" ? "dark" : "light";
    themeRoot.dataset.theme = theme;
    updateLabel();
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Keep the selected theme for the current page.
    }
  });
});
