import { useState } from "react";

export default function PingPanel({ title }) {
  const [response, setResponse] = useState("Sin respuesta todavia.");
  const [loading, setLoading] = useState(false);

  const handlePing = async () => {
    setLoading(true);
    try {
      const result = await window.desktopApi.ping();
      setResponse(JSON.stringify(result));
    } catch (error) {
      setResponse(String(error.message || error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-8">
      <section className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900/80 p-6 shadow-xl">
        <h1 className="text-2xl font-semibold text-slate-100">{title}</h1>
        <p className="mt-2 text-sm text-slate-400">
          Electron IPC -&gt; proceso principal -&gt; proceso hijo de Python (stdin/stdout JSON).
        </p>
        <button
          type="button"
          onClick={handlePing}
          disabled={loading}
          className="mt-5 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-slate-950 transition hover:bg-cyan-400 disabled:opacity-60"
        >
          {loading ? "Enviando..." : "Enviar ping"}
        </button>
        <pre className="mt-4 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
          {response}
        </pre>
      </section>
    </main>
  );
}
