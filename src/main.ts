import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { isTouchFirst } from './ui/device'

// Touch-first devices get the phone layouts (panels as sheets): app.css keys off this class.
document.documentElement.classList.toggle('touch', isTouchFirst())

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
