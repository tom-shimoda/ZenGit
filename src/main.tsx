import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    // Debug実行時のみuseEffectが２度走るのはReactのStrictModeのせい. COすれば１度のみ実行となる
    // <React.StrictMode>
        <App/>
    // </React.StrictMode>
);
