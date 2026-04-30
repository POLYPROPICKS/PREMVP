interface PaginationDotsProps {
  currentIndex: number;
  total: number;
}

export default function PaginationDots({ currentIndex, total }: PaginationDotsProps) {
  return (
    <div className="flex justify-center gap-1.5 py-3">
      {Array.from({ length: total }, (_, index) => (
        <div
          key={index}
          className={`h-2 rounded-full transition-all duration-300 ${
            index === currentIndex
              ? 'bg-cyan-400 w-8 shadow-lg shadow-cyan-400/30'
              : 'bg-gray-600 w-2'
          }`}
        />
      ))}
    </div>
  );
}
