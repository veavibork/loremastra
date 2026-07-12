import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ToastHost from './ToastHost.tsx'
import { installGlobalErrorCapture } from './error-capture.ts'

installGlobalErrorCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ToastHost />
  </StrictMode>,
)
