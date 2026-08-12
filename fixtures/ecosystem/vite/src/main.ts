type BuildMessage = {
  label: string;
  compiler: "TypeScript 7";
};

const message: BuildMessage = {
  label: "Vite transpiles this module with esbuild",
  compiler: "TypeScript 7"
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing fixture root element.");
app.textContent = `${message.label}; ${message.compiler} checks it separately.`;
