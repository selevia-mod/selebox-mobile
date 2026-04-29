import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
const firebaseConfig = {
  apiKey: "AIzaSyAafbIdCpnWYuW6GNm3KGnE5qqVIi-fj-A",
  authDomain: "tales-of-siren-audio-book.firebaseapp.com",
  databaseURL: "https://tales-of-siren-audio-book-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "tales-of-siren-audio-book",
  storageBucket: "tales-of-siren-audio-book.firebasestorage.app",
  messagingSenderId: "413722367479",
  appId: "1:413722367479:web:ce5bf3839700db7ee68af2",
  measurementId: "G-17MM3TJ593",
};
export const app = initializeApp(firebaseConfig);
export const database = getDatabase(app);
