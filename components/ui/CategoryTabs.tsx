import { categoryTabs } from '@/content/category-tabs';
import { CategoryTab as CategoryTabType } from '@/lib/types';

interface CategoryTabProps {
  data: CategoryTabType;
}

function CategoryTab({ data }: CategoryTabProps) {
  return (
    <button
      className={`px-4 py-2 text-xs font-bold transition-all duration-200 rounded-full border ${
        data.isActive
          ? 'bg-gray-900 text-cyan-300 border-cyan-500/50 shadow-lg shadow-cyan-500/30'
          : 'bg-gray-800/50 text-gray-400 border-gray-700 hover:bg-gray-700/50 hover:text-gray-300'
      }`}
    >
      {data.label}
    </button>
  );
}

export default function CategoryTabs() {
  return (
    <div className="flex gap-3 overflow-x-auto pb-3 scroll-smooth">
      {categoryTabs.map((tab) => (
        <CategoryTab key={tab.id} data={tab} />
      ))}
    </div>
  );
}
