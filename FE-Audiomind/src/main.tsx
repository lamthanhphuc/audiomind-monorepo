import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/dashboard.css'
import './styles/dashboard-scenes.css'
import './styles/studio-panels.css'
import './styles/studio-theme.css'
import './styles/studio-fx.css'
import './styles/studio-auth.css'
import './styles/history-scene.css'
import './styles/dynamic-props.css'
import './components/mindmap/mindmap-graph.css'
import './components/mindmap/mindmap-view.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
