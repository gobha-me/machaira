import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createAppRouter } from './router'
import './styles.css'

const app = createApp(App).use(createPinia())
const router = createAppRouter()
app.use(router)
void router.isReady().then(() => app.mount('#app'))
