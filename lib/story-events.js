import { EventEmitter } from "events";

const storyEvents = new EventEmitter();

storyEvents.setMaxListeners(10);

export default storyEvents;
