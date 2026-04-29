import { EventEmitter } from "events";

const tabNavigationEvents = new EventEmitter();
tabNavigationEvents.setMaxListeners(10);

export default tabNavigationEvents;
