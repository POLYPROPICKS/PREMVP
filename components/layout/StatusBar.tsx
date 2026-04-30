export default function StatusBar() {
  return (
    <div className="bg-black text-white px-4 py-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">9:41</span>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 border border-white rounded-sm">
            <div className="w-full h-full bg-white rounded-sm scale-x-75 origin-left"></div>
          </div>
          <div className="w-1 h-1 bg-white rounded-full"></div>
        </div>
      </div>
    </div>
  );
}
