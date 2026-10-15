// Placeholder until Story 1.6 builds the live map.
import type { EventInfo } from '@running-live-tracker/shared';

const placeholder: EventInfo = { eventId: 'pending', name: 'Running live tracker', hasCourse: false, lengthM: null, runners: [] };

const app = document.querySelector<HTMLDivElement>('#app');
if (app) app.textContent = `${placeholder.name}: live map coming soon`;
