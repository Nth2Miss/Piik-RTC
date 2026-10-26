import { mountApp } from './app';
import { createRoomService } from './room-service';
import { initTheme } from './vendor/piik/src/client/ui/theme';
import './vendor/piik/src/client/styles.css';
import './style.css';
import './desktop/capture-picker.css';

initTheme();
const service = createRoomService();
mountApp(service);
void service.initialize();
