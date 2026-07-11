import React from "react";
import ReactDOM from "react-dom/client";
import ChessTrainer from "./ChessTrainer.jsx";

/*
 * The app was originally built to run as a Claude.ai artifact, which
 * provides a `window.storage` key-value API for persistence. Outside
 * that environment (this standalone build), we polyfill the same
 * interface on top of localStorage so profile/settings/ECO-cache
 * persistence keeps working unchanged.
 */
if (!window.storage) {
  window.storage = {
    async get(key) {
      try {
        const v = localStorage.getItem(key);
        return v !== null ? { key, value: v } : null;
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      try {
        localStorage.setItem(key, value);
        return { key, value };
      } catch (e) {
        return null;
      }
    },
    async delete(key) {
      try {
        localStorage.removeItem(key);
        return { key, deleted: true };
      } catch (e) {
        return null;
      }
    },
    async list(prefix) {
      try {
        const keys = Object.keys(localStorage).filter((k) => !prefix || k.startsWith(prefix));
        return { keys };
      } catch (e) {
        return { keys: [] };
      }
    },
  };
}

ReactDOM.createRoot(document.getElementById("root")).render(<ChessTrainer />);
