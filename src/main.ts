import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { isTouchFirst } from './ui/device'
import { bus } from './game/events'
import { uiBlocked } from './game/input'
import { installSound } from './game/sound'

// Touch-first devices get the phone layouts (panels as sheets): app.css keys off this class.
document.documentElement.classList.toggle('touch', isTouchFirst())

// Sound listens on the bus from the start; it plays after the first input.
installSound({ bus, blocked: uiBlocked })

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
