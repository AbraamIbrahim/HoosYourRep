// App.jsx
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import SearchPage from "./SearchPage";
import ResultsPage from "./ResultsPage";

function DistrictRoute() {
  const { district } = useParams();
  if (!/^(?:[1-9]|1[01])$/.test(district ?? "")) {
    return <Navigate to="/" replace />;
  }
  return <ResultsPage district={Number(district)} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<SearchPage />} />
      <Route path="/rep/:district" element={<DistrictRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}