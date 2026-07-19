import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VideoPickerApp } from "./video-picker-app";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VideoPickerApp />
  </StrictMode>,
);
