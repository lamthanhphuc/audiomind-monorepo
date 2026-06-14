import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/dashboard.css'
import './styles/studio-theme.css'
import './styles/studio-fx.css'
import './styles/studio-auth.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
