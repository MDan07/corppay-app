import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc, query, where, addDoc } from 'firebase/firestore';
import { auth, db } from './firebase';

const generateId = () => Math.random().toString(36).substr(2, 9);
const formatMoney = (amount) => new Intl.NumberFormat('kk-KZ', { style: 'currency', currency: 'KZT' }).format(amount);
const getDaysInMonth = (year, month) => new Date(year, month, 0).getDate();

// Free image compressor! Turns an image into a tiny text string to save in Firestore.
const compressImage = (file) => {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 200; // Shrinks to avatar size
                const MAX_HEIGHT = 200;
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_WIDTH) {
                        height *= MAX_WIDTH / width;
                        width = MAX_WIDTH;
                    }
                } else {
                    if (height > MAX_HEIGHT) {
                        width *= MAX_HEIGHT / height;
                        height = MAX_HEIGHT;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.7)); // Compresses quality to keep size tiny
            };
        };
    });
};

const formatDateDisplay = (dateStr) => {
    if (!dateStr) return '';
    const [year, month, day] = dateStr.split('-');
    return `${day}-${month}-${year}`;
};

const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = {
    monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
    thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun'
};

const SHIFT_TYPES = {
    morning: 'Morning', evening: 'Evening', all: 'All Day', off: 'Day Off'
};

const SHIFT_COLORS = {
    morning: 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-400',
    evening: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/30 dark:text-purple-400',
    all: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400',
    off: 'bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400'
};

// --- NEW STAGE 1: EXPANDED LEDGER CATEGORIES ---
const LOG_CATEGORIES = {
    'bonus_overtime': 'Bonus: Overtime / Extra Hours',
    'bonus_target': 'Bonus: Achieved Target',
    'bonus_sales': 'Bonus: Exceeded Sales',
    'bonus_custom': 'Bonus: Custom / Other',
    'deduct_register': 'Deduction: Cash Register Shortage',
    'deduct_inventory': 'Deduction: Inventory / Product Shortage',
    'deduct_report': 'Deduction: Late Report',
    'deduct_damage': 'Deduction: Damaged Products',
    'deduct_waste': 'Deduction: Excessive Waste',
    'deduct_notice': 'Deduction: No Notice Period',
    'deduct_custom': 'Deduction: Custom / Other',
    'advance': 'Advance Payment'
};

const calculatePay = (employee, monthStr, customEndDateStr = null, logsState = {}) => {
    if (!monthStr) return { net: 0, deductions: 0, advances: 0, bonuses: 0, base: 0, proratedBase: 0, breakdown: [], actualShifts: 0, shiftRate: 0 };
    
    // --- NEW STAGE 1 LOGIC: Base salary is calculated exactly on 15 shifts ---
    const TARGET_SHIFTS = 15;
    const shiftRate = employee.baseSalary / TARGET_SHIFTS;

    // We will build the UI to set this array in Stage 2. For now, it defaults to 15 so existing data doesn't break.
    const attendanceForMonth = employee.attendance && employee.attendance[monthStr] ? employee.attendance[monthStr] : null;
    let actualShifts = attendanceForMonth ? attendanceForMonth.length : TARGET_SHIFTS;
    
    let proratedBase = shiftRate * actualShifts;
    
    // Manual override for base pay (UI coming in Stage 2)
    if (employee.customBasePay && employee.customBasePay[monthStr] !== undefined) {
        proratedBase = employee.customBasePay[monthStr];
    }

    const empLogs = (logsState[employee.id] && logsState[employee.id][monthStr]) ? logsState[employee.id][monthStr] : [];
    
    let totalDeductions = 0;
    let totalBonuses = 0;
    let totalAdvances = 0;
    const breakdown = [];

    empLogs.forEach(log => {
        const amount = parseFloat(log.amount) || 0;
        let appliedAmount = amount;
        
        if (log.type.includes('bonus')) {
            totalBonuses += amount;
        } else if (log.type.includes('advance')) {
            totalAdvances += amount;
        } else {
            // It's a deduction. (Fallback for old 'absence' logs)
            if ((log.type === 'absence' || log.type === 'deduct_absence') && amount === 0) {
                appliedAmount = shiftRate; 
            }
            totalDeductions += appliedAmount;
        }
        
        breakdown.push({ ...log, appliedAmount, appliedDeduction: appliedAmount });
    });

    // Prevent net pay from going negative from deductions (advances can still drop it lower)
    if (totalDeductions > proratedBase + totalBonuses) {
        totalDeductions = proratedBase + totalBonuses; 
    }

    // New Net Pay Formula: Base + Bonuses - Deductions - Advances
    const netPay = proratedBase + totalBonuses - totalDeductions - totalAdvances;

    return {
        base: employee.baseSalary, 
        proratedBase, 
        shiftRate, 
        actualShifts,
        targetShifts: TARGET_SHIFTS,
        deductions: totalDeductions, 
        bonuses: totalBonuses,
        advances: totalAdvances,
        net: netPay, 
        breakdown
    };
};

// const ModernDropdown = ({ value, onChange, options }) => {
//     const [isOpen, setIsOpen] = useState(false);
//     const dropdownRef = useRef(null);

//     useEffect(() => {
//         const handleClickOutside = (event) => {
//             if (dropdownRef.current && !dropdownRef.current.contains(event.target)) setIsOpen(false);
//         };
//         document.addEventListener('mousedown', handleClickOutside);
//         return () => document.removeEventListener('mousedown', handleClickOutside);
//     }, []);

//     const selectedLabel = options.find(o => o.value === value)?.label || 'Select Month...';

//     return (
//         <div className="relative inline-block text-left w-full sm:w-64" ref={dropdownRef}>
//             <button type="button" onClick={() => setIsOpen(!isOpen)} className="flex items-center justify-between w-full bg-white dark:bg-[#0a0a0a] border border-gray-300 dark:border-zinc-700 text-gray-900 dark:text-white text-sm rounded-lg p-2.5 shadow-sm hover:border-primary dark:hover:border-zinc-600 transition-colors focus:outline-none">
//                 <span className="truncate">{selectedLabel}</span>
//                 <i className={`fas fa-chevron-down text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}></i>
//             </button>
//             {isOpen && (
//                 <div className="absolute z-40 mt-1 w-full max-h-64 overflow-y-auto bg-white dark:bg-[#111] border border-gray-200 dark:border-zinc-800 rounded-lg shadow-xl font-medium" style={{scrollbarWidth: 'thin'}}>
//                     <div className="py-1">
//                         {options.map((opt) => (
//                             <div key={opt.value} onClick={() => { onChange(opt.value); setIsOpen(false); }} className={`px-4 py-2.5 text-sm cursor-pointer transition-colors flex items-center justify-between ${value === opt.value ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
//                                 <span className="truncate">{opt.label}</span>
//                                 {value === opt.value && <i className="fas fa-check text-primary"></i>}
//                             </div>
//                         ))}
//                     </div>
//                 </div>
//             )}
//         </div>
//     );
// };

const ModernDropdown = ({ value, onChange, options }) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef(null);
    const selectedItemRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Scroll to the selected item automatically when the dropdown opens
    useEffect(() => {
        if (isOpen && selectedItemRef.current) {
            setTimeout(() => {
                selectedItemRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }, 10); // Tiny delay ensures the dropdown is fully rendered before scrolling
        }
    }, [isOpen]);

    const selectedLabel = options.find(o => o.value === value)?.label || 'Select Month...';

    return (
        <div className="relative inline-block text-left w-full sm:w-64" ref={dropdownRef}>
            <button type="button" onClick={() => setIsOpen(!isOpen)} className="flex items-center justify-between w-full bg-white dark:bg-[#0a0a0a] border border-gray-300 dark:border-zinc-700 text-gray-900 dark:text-white text-sm rounded-lg p-2.5 shadow-sm hover:border-primary dark:hover:border-zinc-600 transition-colors focus:outline-none">
                <span className="truncate">{selectedLabel}</span>
                <i className={`fas fa-chevron-down text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}></i>
            </button>
            {isOpen && (
                <div className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto bg-white dark:bg-[#111] border border-gray-200 dark:border-zinc-800 rounded-lg shadow-xl font-medium" style={{scrollbarWidth: 'thin'}}>
                    <div className="py-1">
                        {options.map((opt) => (
                            <div 
                                key={opt.value} 
                                ref={value === opt.value ? selectedItemRef : null}
                                onClick={() => { onChange(opt.value); setIsOpen(false); }} 
                                className={`px-4 py-2.5 text-sm cursor-pointer transition-colors flex items-center justify-between ${value === opt.value ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}
                            >
                                <span className="truncate">{opt.label}</span>
                                {value === opt.value && <i className="fas fa-check text-primary"></i>}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

const ModernDatePicker = ({ value, onChange, placeholder = "Select Date..." }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [currentMonth, setCurrentMonth] = useState(value ? new Date(value) : new Date());
    const dateRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dateRef.current && !dateRef.current.contains(event.target)) setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
    const firstDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();
    
    const handleDateSelect = (day) => {
        const formatted = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        onChange(formatted);
        setIsOpen(false);
    };

    const renderCalendar = () => {
        const days = [];
        for (let i = 0; i < firstDay; i++) days.push(<div key={`empty-${i}`} className="w-8 h-8"></div>);
        for (let i = 1; i <= daysInMonth; i++) {
            const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
            const isSelected = value === dateStr;
            const isToday = new Date().toISOString().split('T')[0] === dateStr;
            
            days.push(
                <button key={i} type="button" onClick={() => handleDateSelect(i)} className={`w-8 h-8 flex items-center justify-center rounded-full text-xs font-medium transition-all ${isSelected ? 'bg-primary text-white shadow-md' : isToday ? 'bg-gray-100 dark:bg-zinc-800 text-primary dark:text-blue-400 font-bold' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
                    {i}
                </button>
            );
        }
        return days;
    };

    return (
        <div className="relative inline-block w-full" ref={dateRef}>
            <button type="button" onClick={() => setIsOpen(!isOpen)} className="flex items-center justify-between w-full border border-gray-300 dark:border-zinc-700 bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-white rounded-md py-2 px-3 text-sm focus:ring-2 focus:ring-primary/50 transition-colors">
                <span className={value ? '' : 'text-gray-500 dark:text-gray-400'}>{value ? formatDateDisplay(value) : placeholder}</span>
                <i className="far fa-calendar-alt text-gray-400"></i>
            </button>
            {isOpen && (
                <div className="absolute z-50 mt-1 p-4 bg-white dark:bg-[#111] border border-gray-200 dark:border-zinc-800 rounded-xl shadow-2xl w-[280px] right-0 sm:right-auto">
                    <div className="flex justify-between items-center mb-4">
                        <button type="button" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))} className="p-1 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded text-gray-500"><i className="fas fa-chevron-left text-xs"></i></button>
                        <span className="font-bold text-sm dark:text-white">{currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
                        <button type="button" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))} className="p-1 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded text-gray-500"><i className="fas fa-chevron-right text-xs"></i></button>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center mb-2">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => <span key={d} className="text-[10px] font-semibold text-gray-400 uppercase">{d}</span>)}</div>
                    <div className="grid grid-cols-7 gap-1 justify-items-center mb-4">{renderCalendar()}</div>
                    <div className="flex justify-between items-center border-t dark:border-zinc-800 pt-3">
                        <button type="button" onClick={() => { const d = new Date(); onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); setIsOpen(false); }} className="text-xs font-semibold text-primary hover:text-blue-700">Select Today</button>
                        <button type="button" onClick={() => setIsOpen(false)} className="text-xs font-medium text-gray-500 hover:text-gray-300">Cancel</button>
                    </div>
                </div>
            )}
        </div>
    );
};


// Premium interactive night atmosphere.
// Small particles add depth while CSS aurora light reacts to the pointer and page scroll.
// No large bubbles or shapes are placed over the application UI.

const StarLayer = ({ count = 180, size = 0.018, opacity = 0.38, color = '#78a7ff', spread = [12, 8, 5], speed = 0.03 }) => {
    const pointsRef = useRef(null);
    const mouse = useRef({ x: 0, y: 0 });
    const scroll = useRef(0);

    const positions = useMemo(() => {
        const values = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            values[i * 3] = (Math.random() - 0.5) * spread[0];
            values[i * 3 + 1] = (Math.random() - 0.5) * spread[1];
            values[i * 3 + 2] = (Math.random() - 0.5) * spread[2];
        }
        return values;
    }, [count, spread]);

    useEffect(() => {
        const move = (event) => {
            mouse.current.x = event.clientX / window.innerWidth - 0.5;
            mouse.current.y = event.clientY / window.innerHeight - 0.5;
        };
        const onScroll = () => { scroll.current = window.scrollY; };
        window.addEventListener('pointermove', move, { passive: true });
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('scroll', onScroll);
        };
    }, []);

    useFrame(({ clock }) => {
        if (!pointsRef.current) return;
        const t = clock.getElapsedTime();
        const targetX = mouse.current.x * 0.28;
        const targetY = -mouse.current.y * 0.18 - Math.sin(scroll.current * 0.001) * 0.04;
        pointsRef.current.rotation.y += (targetX - pointsRef.current.rotation.y) * 0.018;
        pointsRef.current.rotation.x += (targetY - pointsRef.current.rotation.x) * 0.018;
        pointsRef.current.rotation.z = Math.sin(t * speed) * 0.025;
    });

    return (
        <points ref={pointsRef}>
            <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[positions, 3]} />
            </bufferGeometry>
            <pointsMaterial
                color={color}
                size={size}
                sizeAttenuation
                transparent
                opacity={opacity}
                depthWrite={false}
            />
        </points>
    );
};

const InteractiveNightScene = ({ mobile }) => (
    <>
        <StarLayer
            count={mobile ? 85 : 210}
            size={mobile ? 0.024 : 0.018}
            opacity={0.34}
            color="#7aa8ff"
            spread={[13, 9, 5]}
            speed={0.025}
        />
        <StarLayer
            count={mobile ? 35 : 80}
            size={mobile ? 0.05 : 0.035}
            opacity={0.18}
            color="#b48cff"
            spread={[11, 7, 4]}
            speed={0.018}
        />
    </>
);

const LiquidNightBackground = ({ theme }) => {
    const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
    const [reducedMotion, setReducedMotion] = useState(() =>
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    const bgRef = useRef(null);

    useEffect(() => {
        const update = () => setMobile(window.innerWidth < 768);
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const updateMotion = () => setReducedMotion(media.matches);

        let raf = 0;
        let targetX = 50, targetY = 36, currentX = 50, currentY = 36;

        const apply = () => {
            currentX += (targetX - currentX) * 0.08;
            currentY += (targetY - currentY) * 0.08;
            if (bgRef.current) {
                bgRef.current.style.setProperty('--mx', `${currentX}%`);
                bgRef.current.style.setProperty('--my', `${currentY}%`);
            }
            raf = requestAnimationFrame(apply);
        };

        const move = (event) => {
            targetX = (event.clientX / window.innerWidth) * 100;
            targetY = (event.clientY / window.innerHeight) * 100;
        };

        const onScroll = () => {
            if (bgRef.current) {
                bgRef.current.style.setProperty('--scroll-shift', `${Math.min(window.scrollY * 0.018, 22)}px`);
            }
        };

        window.addEventListener('resize', update);
        window.addEventListener('pointermove', move, { passive: true });
        window.addEventListener('scroll', onScroll, { passive: true });
        media.addEventListener?.('change', updateMotion);
        apply();

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', update);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('scroll', onScroll);
            media.removeEventListener?.('change', updateMotion);
        };
    }, []);

    if (theme !== 'dark') return null;

    return (
        <div
            ref={bgRef}
            aria-hidden="true"
            className={`corp-aurora-bg fixed inset-0 pointer-events-none z-0 overflow-hidden ${reducedMotion ? 'corp-motion-reduced' : ''}`}
        >
            <div className="corp-aurora corp-aurora-a" />
            <div className="corp-aurora corp-aurora-b" />
            <div className="corp-pointer-glow" />
            {!reducedMotion && (
                <Canvas
                    dpr={[1, mobile ? 1.1 : 1.35]}
                    gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
                    camera={{ position: [0, 0, 8], fov: 45, near: 0.1, far: 100 }}
                    style={{ background: 'transparent' }}
                >
                    <InteractiveNightScene mobile={mobile} />
                </Canvas>
            )}
        </div>
    );
};

export default function App() {
    const [theme, setTheme] = useState('light');
    const [currentView, setCurrentView] = useState('dashboard');
    const [selectedMonth, setSelectedMonth] = useState('');
    const [selectedEmployeeId, setSelectedEmployeeId] = useState(null);
    const [selectedCafe, setSelectedCafe] = useState('all');
    // Dashboard timeline navigator: keeps a 7-day window centered around the selected day.
    const [timelineOffset, setTimelineOffset] = useState(0);
    const timelineTouchRef = useRef({ x: 0, y: 0 });
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    
    const [cafes, setCafes] = useState([]);
    const [employees, setEmployees] = useState([]);
    // Global role templates: each role can carry its own default salary.
    const [roles, setRoles] = useState([]);
    const [isAddingRole, setIsAddingRole] = useState(false);
    const [isSavingRole, setIsSavingRole] = useState(false);
    const [isDeletingRole, setIsDeletingRole] = useState(false);
    const [isSavingCustomModal, setIsSavingCustomModal] = useState(false);
    const [newRoleName, setNewRoleName] = useState('');
    const [newRoleSalary, setNewRoleSalary] = useState('');
    // Dedicated role action modal. Keeping role edit/delete separate from the generic modal
    // prevents modal state collisions and makes the role controls independently reliable.
    const [roleActionModal, setRoleActionModal] = useState({
        isOpen: false,
        mode: null,
        role: null,
        name: '',
        salary: ''
    });
    const [hireRole, setHireRole] = useState('');
    const [hireSalary, setHireSalary] = useState('');
    const [isHireRolePickerOpen, setIsHireRolePickerOpen] = useState(false);
    const [isCustomRolePickerOpen, setIsCustomRolePickerOpen] = useState(false);
    const [logs, setLogs] = useState({});
    const [payments, setPayments] = useState({});
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState(null);

    const [isAddEmpOpen, setIsAddEmpOpen] = useState(false);
    const [isPayModalOpen, setIsPayModalOpen] = useState(false);
    const [isAddCafeOpen, setIsAddCafeOpen] = useState(false);
    const [isDeleteCafeOpen, setIsDeleteCafeOpen] = useState(false);
    const [isDeletingCafe, setIsDeletingCafe] = useState(false);
    const [employeeRoleFilter, setEmployeeRoleFilter] = useState('all');
    const [employeeSort, setEmployeeSort] = useState('name');
    const [employeeViewMode, setEmployeeViewMode] = useState('grid');
    const [toast, setToast] = useState(null);
    const [cafeToDelete, setCafeToDelete] = useState(null);
    const [alertConfig, setAlertConfig] = useState({ isOpen: false, title: '', message: '', onConfirm: null });
    const [customModal, setCustomModal] = useState({ isOpen: false, title: '', description: '', fields: [], values: {}, confirmLabel: 'Save', danger: false, onSave: null });
    // Global close handler so the modal can safely render from the app root
    const closeCustomModal = () => {
        if (isSavingCustomModal) return;
        setIsCustomRolePickerOpen(false);
        setCustomModal(prev => ({ ...prev, isOpen: false }));
    };
    const submitCustomModal = async () => {
        if (isSavingCustomModal || !customModal.onSave) return;
        if (!lockSubmission('custom-modal-submit')) return;
        setIsSavingCustomModal(true);
        try {
            await customModal.onSave(customModal.values);
        } finally {
            setIsSavingCustomModal(false);
            unlockSubmission('custom-modal-submit');
        }
    };

    const showToast = (message, type = 'success') => {
        setToast({ message, type, id: Date.now() });
        window.setTimeout(() => setToast(prev => prev && prev.id ? null : prev), 3200);
    };

    const [payModalData, setPayModalData] = useState({ isCustom: false, customDate: '', remarks: '' });
    const [isScheduleOpen, setIsScheduleOpen] = useState(false);
    const [editingSchedule, setEditingSchedule] = useState({});
const [detailMonth, setDetailMonth] = useState('');
   const [logForm, setLogForm] = useState({ date: '', type: 'bonus_overtime', reason: '', amount: '' });
    const [quickOvertime, setQuickOvertime] = useState({ date: '', hours: '', customRate: '' });
    const [isAddingEmployee, setIsAddingEmployee] = useState(false);
    const [isAddingCafe, setIsAddingCafe] = useState(false);
    const [isAddingLog, setIsAddingLog] = useState(false);
    const [isAddingQuickOvertime, setIsAddingQuickOvertime] = useState(false);
    const [isSavingPayment, setIsSavingPayment] = useState(false);
    const submissionLocksRef = useRef(new Set());

    const [holdProgress, setHoldProgress] = useState(0);
    const [activeHoldCafe, setActiveHoldCafe] = useState(null);
    const longPressTimerRef = useRef(null);
    const progressIntervalRef = useRef(null);
    const longPressCompletedRef = useRef(false);
    const LONG_PRESS_DURATION = 6000;

    const lockSubmission = (key) => {
        if (submissionLocksRef.current.has(key)) return false;
        submissionLocksRef.current.add(key);
        return true;
    };
    const unlockSubmission = (key) => submissionLocksRef.current.delete(key);

    useEffect(() => {
        const storedTheme = localStorage.getItem('theme');
        if (storedTheme === 'dark' || (!storedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            setTheme('dark');
            document.documentElement.classList.add('dark');
        } else {
            setTheme('light');
            document.documentElement.classList.remove('dark');
        }

        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            if (currentUser) {
                loadDataFromFirebase();
            } else {
                setLoading(false);
            }
        });

        return () => unsubscribe();
    }, []);

    const loadDataFromFirebase = async () => {
        setLoading(true);
        try {
            const now = new Date();
            const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            setSelectedMonth(currentMonthStr);
            setDetailMonth(currentMonthStr);

            const cafesQuery = query(collection(db, 'cafes'));
            const cafesSnapshot = await getDocs(cafesQuery);
            const cafesData = cafesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setCafes(cafesData);

            const employeesQuery = query(collection(db, 'employees'));
            const employeesSnapshot = await getDocs(employeesQuery);
            const employeesData = employeesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setEmployees(employeesData);

            const rolesQuery = query(collection(db, 'roles'));
            const rolesSnapshot = await getDocs(rolesQuery);
            const rolesData = rolesSnapshot.docs.map(roleDoc => ({ id: roleDoc.id, ...roleDoc.data() }))
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            setRoles(rolesData);

            const logsQuery = query(collection(db, 'logs'));
            const logsSnapshot = await getDocs(logsQuery);
            const logsData = {};
            logsSnapshot.docs.forEach(doc => {
                const log = doc.data();
                if (!logsData[log.employeeId]) logsData[log.employeeId] = {};
                if (!logsData[log.employeeId][log.month]) logsData[log.employeeId][log.month] = [];
                logsData[log.employeeId][log.month].push({ id: doc.id, ...log });
            });
            setLogs(logsData);

            const paymentsQuery = query(collection(db, 'payments'));
            const paymentsSnapshot = await getDocs(paymentsQuery);
            const paymentsData = {};
            paymentsSnapshot.docs.forEach(doc => {
                const payment = doc.data();
                if (!paymentsData[payment.employeeId]) paymentsData[payment.employeeId] = {};
                paymentsData[payment.employeeId][payment.month] = { id: doc.id, ...payment };
            });
            setPayments(paymentsData);

        } catch (error) {
            console.error('Error loading data:', error);
            setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to load data from database.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
        } finally {
            setLoading(false);
        }
    };

    const toggleTheme = () => {
        if (theme === 'light') {
            setTheme('dark');
            document.documentElement.classList.add('dark');
            localStorage.setItem('theme', 'dark');
        } else {
            setTheme('light');
            document.documentElement.classList.remove('dark');
            localStorage.setItem('theme', 'light');
        }
    };

    const handleLogin = async (e) => {
        e.preventDefault();
        const email = e.target.email.value;
        const password = e.target.password.value;
        
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (error) {
            setAlertConfig({ isOpen: true, title: 'Login Failed', message: error.message, onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
        }
    };

    const handleLogout = async () => {
        await signOut(auth);
        setCurrentView('dashboard');
        setSelectedCafe('all');
        setMobileMenuOpen(false);
    };

    const handleLogoClick = () => {
        setCurrentView('dashboard');
        setSelectedCafe('all');
        setMobileMenuOpen(false);
    };

    const generateMonthOptions = () => {
        const options = [];
        const now = new Date();
        for (let i = -60; i <= 12; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
            const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            let label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            
            if (i === 0) {
                label = `📍 ${label} (Current Month)`;
            }
            
            options.push({ value: val, label });
        }
        return options;
    };




    const getRoleTemplate = (roleName) => roles.find(role => String(role.name || '').trim().toLowerCase() === String(roleName || '').trim().toLowerCase());

    const saveRole = async (name, salary, roleId = null) => {
        if (!lockSubmission(`save-role:${roleId || 'new'}`)) return false;
        const cleanName = String(name || '').trim();
        const cleanSalary = parseFloat(salary);
        if (!cleanName || Number.isNaN(cleanSalary) || cleanSalary < 0) {
            unlockSubmission(`save-role:${roleId || 'new'}`);
            return false;
        }

        setIsSavingRole(true);
        try {
            // Editing always updates the exact role document, so renaming never creates a duplicate.
            const sameNameRole = roles.find(r =>
                r.id !== roleId &&
                String(r.name || '').trim().toLowerCase() === cleanName.toLowerCase()
            );

            if (sameNameRole && roleId) {
                setAlertConfig({
                    isOpen: true,
                    title: 'Role Already Exists',
                    message: `A role named “${cleanName}” already exists. Choose a different name.`,
                    onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false }))
                });
                return false;
            }

            if (roleId) {
                await updateDoc(doc(db, 'roles', roleId), { name: cleanName, salary: cleanSalary });
                setRoles(prev => prev.map(r => r.id === roleId ? { ...r, name: cleanName, salary: cleanSalary } : r)
                    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))));
            } else if (sameNameRole) {
                // Add Role with an existing name behaves as an update instead of creating another document.
                await updateDoc(doc(db, 'roles', sameNameRole.id), { name: cleanName, salary: cleanSalary });
                setRoles(prev => prev.map(r => r.id === sameNameRole.id ? { ...r, name: cleanName, salary: cleanSalary } : r));
            } else {
                const docRef = await addDoc(collection(db, 'roles'), { name: cleanName, salary: cleanSalary });
                setRoles(prev => [...prev, { id: docRef.id, name: cleanName, salary: cleanSalary }]
                    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))));
            }
            return true;
        } catch (error) {
            console.error('Error saving role:', error);
            setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to save role.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) });
            return false;
        } finally {
            setIsSavingRole(false);
            unlockSubmission(`save-role:${roleId || 'new'}`);
        }
    };

    const deleteRole = async (role) => {
        if (!lockSubmission(`delete-role:${role.id}`)) return false;
        setIsDeletingRole(true);
        try {
            await deleteDoc(doc(db, 'roles', role.id));
            setRoles(prev => prev.filter(r => r.id !== role.id));
            return true;
        } catch (error) {
            console.error('Error deleting role:', error);
            setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to delete role.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) });
            return false;
        } finally {
            setIsDeletingRole(false);
            unlockSubmission(`delete-role:${role.id}`);
        }
    };

    const closeRoleActionModal = () => {
        if (isSavingRole || isDeletingRole) return;
        setRoleActionModal({ isOpen: false, mode: null, role: null, name: '', salary: '' });
    };

    const openDeleteRoleModal = (role) => {
        if (!role?.id || isSavingRole || isDeletingRole) return;
        setRoleActionModal({
            isOpen: true,
            mode: 'delete',
            role,
            name: role.name || '',
            salary: String(role.salary ?? '')
        });
    };

    const openEditRoleModal = (role) => {
        if (!role?.id || isSavingRole || isDeletingRole) return;
        setRoleActionModal({
            isOpen: true,
            mode: 'edit',
            role,
            name: role.name || '',
            salary: String(role.salary ?? '')
        });
    };

    const submitRoleAction = async () => {
        const modal = roleActionModal;
        if (!modal.role?.id || isSavingRole || isDeletingRole) return;
        if (modal.mode === 'delete') {
            const deleted = await deleteRole(modal.role);
            if (deleted) closeRoleActionModal();
            return;
        }
        if (modal.mode === 'edit') {
            const saved = await saveRole(modal.name, modal.salary, modal.role.id);
            if (saved) closeRoleActionModal();
        }
    };

    const getFilteredEmployees = (employeeList = employees) => {
        if (selectedCafe === 'all') return employeeList;
        return employeeList.filter(emp => emp.cafeId === selectedCafe);
    };

    const handleAddCafe = async (e) => {
        e.preventDefault();
        if (!lockSubmission('add-cafe')) return;
        setIsAddingCafe(true);
        const formData = new FormData(e.target);
        const colors = ['bg-blue-500', 'bg-green-500', 'bg-orange-500', 'bg-purple-500', 'bg-red-500', 'bg-cyan-500', 'bg-pink-500', 'bg-yellow-500', 'bg-indigo-500', 'bg-teal-500'];
        
        try {
            const newCafe = {
                name: formData.get('name'),
                location: formData.get('location'),
                color: colors[cafes.length % colors.length]
            };
            const docRef = await addDoc(collection(db, 'cafes'), newCafe);
            setCafes([...cafes, { id: docRef.id, ...newCafe }]);
            setIsAddCafeOpen(false);
        } catch (error) {
            console.error('Error adding cafe:', error);
            setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to add cafe.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
        } finally {
            unlockSubmission('add-cafe');
            setIsAddingCafe(false);
        }
    };

    const confirmDeleteCafe = (cafeId) => {
        setCafeToDelete(cafeId);
        setIsDeleteCafeOpen(true);
        setActiveHoldCafe(null);
        setHoldProgress(0);
    };

    const handleDeleteCafe = async () => {
        if (!cafeToDelete || isDeletingCafe) return;
        if (!lockSubmission(`delete-cafe:${cafeToDelete}`)) return;
        setIsDeletingCafe(true);
        const deletingId = cafeToDelete;
        try {
            const employeesInCafe = employees.filter(emp => emp.cafeId === deletingId);
            if (employeesInCafe.length > 0) {
                setAlertConfig({
                    isOpen: true,
                    title: 'Cannot Delete Cafe',
                    message: `This cafe has ${employeesInCafe.length} employee(s) assigned. Please reassign or remove all employees before deleting this cafe.`,
                    onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false}))
                });
                return;
            }
            await deleteDoc(doc(db, 'cafes', deletingId));
            setCafes(prev => prev.filter(c => c.id !== deletingId));
            if (selectedCafe === deletingId) setSelectedCafe('all');
            setIsDeleteCafeOpen(false);
            setCafeToDelete(null);
            setActiveHoldCafe(null);
            setHoldProgress(0);
            showToast('Cafe deleted successfully', 'success');
        } catch (error) {
            console.error('Error deleting cafe:', error);
            showToast('Failed to delete cafe', 'error');
            setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to delete cafe.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
        } finally {
            setIsDeletingCafe(false);
            unlockSubmission(`delete-cafe:${deletingId}`);
        }
    };

    const handleScheduleSave = async () => {
        if (!selectedEmployeeId) return;
        
        try {
            await updateDoc(doc(db, 'employees', selectedEmployeeId), {
                schedule: editingSchedule
            });
            setEmployees(employees.map(emp => 
                emp.id === selectedEmployeeId 
                    ? { ...emp, schedule: editingSchedule }
                    : emp
            ));
            setIsScheduleOpen(false);
        } catch (error) {
            console.error('Error updating schedule:', error);
            setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to update schedule.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
        }
    };

    const openScheduleEditor = (employee) => {
        setSelectedEmployeeId(employee.id);
        setEditingSchedule(employee.schedule || {
            monday: { shift: 'off', hours: '' },
            tuesday: { shift: 'off', hours: '' },
            wednesday: { shift: 'off', hours: '' },
            thursday: { shift: 'off', hours: '' },
            friday: { shift: 'off', hours: '' },
            saturday: { shift: 'off', hours: '' },
            sunday: { shift: 'off', hours: '' }
        });
        setIsScheduleOpen(true);
    };

    const openEmployeeDetail = (employeeId, month) => {
        setSelectedEmployeeId(employeeId);
        setDetailMonth(month || selectedMonth);
        setCurrentView('employee-detail');
        setMobileMenuOpen(false);
    };

const downloadPayslip = async (empId, monthStr) => {
        const emp = employees.find(e => e.id === empId);
        if (!emp || !payments[empId] || !payments[empId][monthStr]) return;

        // Open immediately from the user action so popup blockers do not interfere.
        // The finished PDF replaces this loading screen. No automatic print dialog is used.
        const pdfTab = window.open('', '_blank');
        if (!pdfTab) {
            setAlertConfig({
                isOpen: true,
                title: 'Popup Blocked',
                message: 'Please allow popups so CorpPay can open the payslip PDF in a new tab.',
                onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false }))
            });
            return;
        }

        pdfTab.document.write(`
            <!doctype html>
            <html>
            <head><title>Preparing payslip…</title></head>
            <body style="margin:0;background:#090d18;display:grid;place-items:center;height:100vh;color:#dbeafe;font:600 16px Arial">
                <div style="text-align:center">
                    <div style="width:38px;height:38px;border:3px solid #273449;border-top-color:#60a5fa;border-radius:50%;margin:0 auto 16px;animation:r .8s linear infinite"></div>
                    Preparing your payslip…
                </div>
                <style>@keyframes r{to{transform:rotate(360deg)}}</style>
            </body>
            </html>
        `);
        pdfTab.document.close();

        const payment = payments[empId][monthStr];
        const payInfo = calculatePay(emp, monthStr, payment.customEndDate, logs);
        const [year, month] = monthStr.split('-');
        const dateObj = new Date(Number(year), Number(month) - 1, 1);
        let monthDisplay = dateObj.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
        monthDisplay = monthDisplay.charAt(0).toUpperCase() + monthDisplay.slice(1);

        const cafeInfo = cafes.find(c => c.id === emp.cafeId);
        const breakdown = [...(payInfo.breakdown || [])]
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        const W = 1240;
        const H = 1754;
        const M = 76;
        const C = {
            bg: '#090d18',
            panel: '#111827',
            panel2: '#151f31',
            panel3: '#0f172a',
            line: '#263449',
            ink: '#f8fafc',
            muted: '#94a3b8',
            blue: '#60a5fa',
            blueDeep: '#2563eb',
            violet: '#a78bfa',
            green: '#4ade80',
            red: '#fb7185',
            amber: '#fbbf24'
        };

        const money = n =>
            new Intl.NumberFormat('kk-KZ', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }).format(Number(n || 0)) + ' KZT';

        const fitText = (ctx, value, maxWidth, font) => {
            ctx.font = font;
            let out = String(value || '—');
            if (ctx.measureText(out).width <= maxWidth) return out;
            while (out.length && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
            return out + '…';
        };

        const loadImage = src => new Promise(resolve => {
            if (!src) return resolve(null);
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = src;
        });

        const profileImage = await loadImage(emp.profilePic);

        const createPage = () => {
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');
            ctx.textBaseline = 'alphabetic';

            const bg = ctx.createLinearGradient(0, 0, W, H);
            bg.addColorStop(0, '#070b14');
            bg.addColorStop(.5, '#0b1120');
            bg.addColorStop(1, '#090d18');
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, H);

            const glow1 = ctx.createRadialGradient(W * .88, 80, 0, W * .88, 80, 520);
            glow1.addColorStop(0, 'rgba(96,165,250,.14)');
            glow1.addColorStop(1, 'rgba(96,165,250,0)');
            ctx.fillStyle = glow1;
            ctx.fillRect(0, 0, W, H);

            const glow2 = ctx.createRadialGradient(120, H * .86, 0, 120, H * .86, 420);
            glow2.addColorStop(0, 'rgba(167,139,250,.08)');
            glow2.addColorStop(1, 'rgba(167,139,250,0)');
            ctx.fillStyle = glow2;
            ctx.fillRect(0, 0, W, H);

            return { canvas, ctx };
        };

        const roundRect = (ctx, x, y, w, h, r, fill, stroke = null) => {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, r);
            if (fill) {
                ctx.fillStyle = fill;
                ctx.fill();
            }
            if (stroke) {
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        };

        const drawText = (ctx, value, x, y, font, color, align = 'left') => {
            ctx.font = font;
            ctx.fillStyle = color;
            ctx.textAlign = align;
            ctx.fillText(value, x, y);
        };

        const drawLine = (ctx, x1, y1, x2, y2, color = C.line, width = 1) => {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.stroke();
        };

        const drawProfile = (ctx, x, y, size) => {
            ctx.save();
            ctx.beginPath();
            ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
            ctx.clip();

            if (profileImage) {
                const scale = Math.max(size / profileImage.width, size / profileImage.height);
                const dw = profileImage.width * scale;
                const dh = profileImage.height * scale;
                ctx.drawImage(
                    profileImage,
                    x + (size - dw) / 2,
                    y + (size - dh) / 2,
                    dw,
                    dh
                );
            } else {
                const g = ctx.createLinearGradient(x, y, x + size, y + size);
                g.addColorStop(0, '#2563eb');
                g.addColorStop(1, '#7c3aed');
                ctx.fillStyle = g;
                ctx.fillRect(x, y, size, size);
                const initials = String(emp.name || '?')
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map(p => p[0])
                    .join('')
                    .toUpperCase() || '?';
                drawText(ctx, initials, x + size / 2, y + size * .62, `800 ${Math.round(size * .34)}px Arial`, '#ffffff', 'center');
            }

            ctx.restore();
            ctx.beginPath();
            ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,.28)';
            ctx.lineWidth = 3;
            ctx.stroke();
        };

        const drawBrandHeader = (ctx, pageNumber, totalPages) => {
            const brandGrad = ctx.createLinearGradient(M, 0, M + 280, 0);
            brandGrad.addColorStop(0, '#60a5fa');
            brandGrad.addColorStop(1, '#a78bfa');

            drawText(ctx, 'CorpPay', M, 96, '800 48px Arial', brandGrad);
            drawText(ctx, 'РАСЧЕТНЫЙ ЛИСТ · ОТЧЕТ О РАБОТЕ', M, 134, '700 15px Arial', C.muted);
            drawText(
                ctx,
                cafeInfo ? `${cafeInfo.name}${cafeInfo.location ? ' · ' + cafeInfo.location : ''}` : 'CorpPay',
                M,
                166,
                '700 18px Arial',
                C.blue
            );

            drawText(ctx, monthDisplay, W - M, 94, '800 27px Arial', C.ink, 'right');
            drawText(ctx, `Оплачено: ${formatDateDisplay(payment.datePaid)}`, W - M, 130, '500 15px Arial', C.muted, 'right');

            drawLine(ctx, M, 196, W - M, 196, C.blue, 4);

            if (pageNumber > 1) {
                drawText(ctx, 'ДЕТАЛЬНЫЙ ФИНАНСОВЫЙ ЖУРНАЛ · ПРОДОЛЖЕНИЕ', M, 244, '800 18px Arial', C.ink);
                drawText(ctx, `${emp.name}`, W - M, 244, '600 15px Arial', C.muted, 'right');
                drawLine(ctx, M, 264, W - M, 264, C.line, 2);
            }

            drawLine(ctx, M, H - 82, W - M, H - 82, C.line);
            drawText(
                ctx,
                'Этот документ автоматически сгенерирован системой управления CorpPay.',
                W / 2,
                H - 48,
                '500 12px Arial',
                C.muted,
                'center'
            );
            drawText(ctx, 'CorpPay · Payslip', M, H - 22, '700 11px Arial', '#64748b');
            drawText(ctx, `${pageNumber} / ${totalPages}`, W - M, H - 22, '700 11px Arial', '#64748b', 'right');
        };

        // The first page keeps the original payroll summary, then the financial
        // journal continues across as many pages as needed. No records are sliced off.
        const firstRowsCapacity = 10;
        const continuationRowsCapacity = 20;
        const totalPages = Math.max(
            1,
            breakdown.length <= firstRowsCapacity
                ? 1
                : 1 + Math.ceil((breakdown.length - firstRowsCapacity) / continuationRowsCapacity)
        );

        const pages = [];

        const drawTableHeader = (ctx, y) => {
            const tableX = M;
            const tableW = W - M * 2;
            roundRect(ctx, tableX, y, tableW, 48, 16, '#172238', '#31425e');
            const cols = [tableX + 24, tableX + 170, tableX + 430, tableX + tableW - 24];
            drawText(ctx, 'ДАТА', cols[0], y + 31, '800 13px Arial', '#b6c6dd');
            drawText(ctx, 'КАТЕГОРИЯ', cols[1], y + 31, '800 13px Arial', '#b6c6dd');
            drawText(ctx, 'ПРИМЕЧАНИЯ / ПРИЧИНА', cols[2], y + 31, '800 13px Arial', '#b6c6dd');
            drawText(ctx, 'СУММА', cols[3], y + 31, '800 13px Arial', '#b6c6dd', 'right');
            return { y: y + 48, cols, tableX, tableW };
        };

        const drawRows = (ctx, rows, y, cols, tableX, tableW, startIndex) => {
            const rh = 58;
            rows.forEach((log, i) => {
                const absoluteIndex = startIndex + i;
                const type = String(log.type || '');
                const isBonus = type.includes('bonus');
                const isAdvance = type.includes('advance');
                const color = isBonus ? C.green : isAdvance ? C.blue : C.red;
                const sign = isBonus ? '+' : '-';
                const label = LOG_CATEGORIES[log.type] || log.type || '—';
                const fill = absoluteIndex % 2 ? '#0f1728' : '#111c2e';

                roundRect(ctx, tableX, y, tableW, rh, 0, fill, '#223149');
                drawText(ctx, formatDateDisplay(log.date), cols[0], y + 36, '500 14px Arial', '#cbd5e1');
                drawText(ctx, fitText(ctx, label, 235, '600 14px Arial'), cols[1], y + 36, '600 14px Arial', C.ink);
                drawText(ctx, fitText(ctx, log.reason || '—', 355, '500 14px Arial'), cols[2], y + 36, '500 14px Arial', C.muted);
                drawText(ctx, sign + money(log.appliedAmount), cols[3], y + 36, '700 14px Arial', color, 'right');
                y += rh;
            });
            return y;
        };

        // FIRST PAGE
        {
            const { canvas, ctx } = createPage();
            drawBrandHeader(ctx, 1, totalPages);

            const cardY = 236;
            const gap = 24;
            const cardW = (W - M * 2 - gap) / 2;
            const cardH = 176;

            roundRect(ctx, M, cardY, cardW, cardH, 24, C.panel, '#2b3b55');
            roundRect(ctx, M + cardW + gap, cardY, cardW, cardH, 24, C.panel, '#2b3b55');

            drawProfile(ctx, M + 26, cardY + 32, 108);
            drawText(ctx, 'ДАННЫЕ СОТРУДНИКА', M + 158, cardY + 48, '700 13px Arial', C.muted);
            drawText(ctx, fitText(ctx, emp.name, cardW - 190, '800 27px Arial'), M + 158, cardY + 92, '800 27px Arial', C.ink);
            drawText(ctx, fitText(ctx, emp.role || '—', cardW - 190, '500 17px Arial'), M + 158, cardY + 126, '500 17px Arial', '#cbd5e1');
            drawText(ctx, 'Профиль сотрудника', M + 158, cardY + 154, '500 13px Arial', C.muted);

            const x2 = M + cardW + gap;
            drawText(ctx, 'ПЕРИОД ОПЛАТЫ', x2 + 28, cardY + 48, '700 13px Arial', C.muted);
            drawText(ctx, payment.type === 'partial' ? 'Неполный месяц' : 'Полный месяц', x2 + 28, cardY + 94, '800 27px Arial', C.ink);
            drawText(
                ctx,
                `Отработано: ${payInfo.actualShifts} смен · Норма: ${payInfo.targetShifts}`,
                x2 + 28,
                cardY + 132,
                '500 16px Arial',
                '#cbd5e1'
            );
            drawText(ctx, `${breakdown.length} финансовых записей за период`, x2 + 28, cardY + 158, '500 13px Arial', C.blue);

            let y = 462;
            drawText(ctx, 'СВОДКА НАЧИСЛЕНИЙ И УДЕРЖАНИЙ', M, y, '800 19px Arial', C.ink);
            y += 24;
            drawLine(ctx, M, y, W - M, y, C.line, 2);
            y += 18;

            const summary = [
                ['Оплата за смены (Начислено)', money(payInfo.proratedBase), C.ink, C.panel3],
                ['Итого премий (Бонусы)', '+' + money(payInfo.bonuses), C.green, '#10251a'],
                ['Итого удержаний за нарушения', '-' + money(payInfo.deductions), C.red, '#2a111c'],
                ['Выданные авансы', '-' + money(payInfo.advances), C.blue, '#101d31']
            ];

            const rowH = 56;
            roundRect(ctx, M, y, W - M * 2, rowH * summary.length + 78, 20, C.panel, '#2b3b55');

            summary.forEach((row, i) => {
                const ry = y + i * rowH;
                if (i) drawLine(ctx, M + 22, ry, W - M - 22, ry, '#263449');
                ctx.fillStyle = row[3];
                ctx.fillRect(M + 1, ry + 1, W - M * 2 - 2, rowH - 1);
                drawText(ctx, row[0], M + 26, ry + 36, '600 17px Arial', row[2]);
                drawText(ctx, row[1], W - M - 26, ry + 36, '700 17px Arial', row[2], 'right');
            });

            const totalY = y + rowH * summary.length;
            const totalGrad = ctx.createLinearGradient(M, totalY, W - M, totalY + 78);
            totalGrad.addColorStop(0, '#13284a');
            totalGrad.addColorStop(1, '#241b45');
            roundRect(ctx, M + 1, totalY, W - M * 2 - 2, 77, 0, totalGrad);
            drawText(ctx, 'ИТОГО К ВЫПЛАТЕ', M + 26, totalY + 49, '800 23px Arial', '#ffffff');
            drawText(ctx, money(payment.amount), W - M - 26, totalY + 49, '800 27px Arial', '#93c5fd', 'right');

            y = totalY + 120;
            drawText(ctx, 'ДЕТАЛЬНЫЙ ФИНАНСОВЫЙ ЖУРНАЛ', M, y, '800 19px Arial', C.ink);
            y += 24;
            drawLine(ctx, M, y, W - M, y, C.line, 2);
            y += 18;

            const header = drawTableHeader(ctx, y);
            y = header.y;

            const firstRows = breakdown.slice(0, firstRowsCapacity);

            if (!firstRows.length) {
                roundRect(ctx, header.tableX, y, header.tableW, 68, 0, C.panel, '#223149');
                drawText(ctx, 'Записей нет.', W / 2, y + 42, 'italic 16px Arial', C.muted, 'center');
            } else {
                drawRows(ctx, firstRows, y, header.cols, header.tableX, header.tableW, 0);
            }

            pages.push(canvas);
        }

        // CONTINUATION PAGES — every remaining financial record is included.
        for (let offset = firstRowsCapacity, pageIndex = 2; offset < breakdown.length; offset += continuationRowsCapacity, pageIndex++) {
            const { canvas, ctx } = createPage();
            drawBrandHeader(ctx, pageIndex, totalPages);

            let y = 292;
            const header = drawTableHeader(ctx, y);
            y = header.y;

            const rows = breakdown.slice(offset, offset + continuationRowsCapacity);
            y = drawRows(ctx, rows, y, header.cols, header.tableX, header.tableW, offset);

            if (pageIndex === totalPages && payment.remarks && y < H - 220) {
                y += 28;
                roundRect(ctx, M, y, W - M * 2, 100, 20, '#251e10', '#6f5721');
                drawText(ctx, 'ПРИМЕЧАНИЯ МЕНЕДЖЕРА', M + 24, y + 33, '800 13px Arial', C.amber);
                drawText(
                    ctx,
                    fitText(ctx, payment.remarks, W - M * 2 - 48, '500 16px Arial'),
                    M + 24,
                    y + 70,
                    '500 16px Arial',
                    '#fde68a'
                );
            }

            pages.push(canvas);
        }

        // If there are no continuation pages, place remarks on the first page when possible.
        if (pages.length === 1 && payment.remarks) {
            const ctx = pages[0].getContext('2d');
            roundRect(ctx, M, H - 210, W - M * 2, 92, 20, '#251e10', '#6f5721');
            drawText(ctx, 'ПРИМЕЧАНИЯ МЕНЕДЖЕРА', M + 24, H - 177, '800 13px Arial', C.amber);
            drawText(
                ctx,
                fitText(ctx, payment.remarks, W - M * 2 - 48, '500 16px Arial'),
                M + 24,
                H - 142,
                '500 16px Arial',
                '#fde68a'
            );
        }

        const pageImages = [];
        for (const canvas of pages) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.96));
            if (!blob) {
                pdfTab.close();
                return;
            }
            pageImages.push(new Uint8Array(await blob.arrayBuffer()));
        }

        // Build a real multi-page PDF. The browser's PDF viewer then provides
        // its normal Save/Download and Print controls without forcing a print dialog.
        const enc = new TextEncoder();
        const parts = [];
        const offsets = [];
        let length = 0;

        const push = value => {
            const bytes = typeof value === 'string' ? enc.encode(value) : value;
            parts.push(bytes);
            length += bytes.length;
        };

        const obj = (number, body) => {
            offsets[number] = length;
            push(`${number} 0 obj\n`);
            push(body);
            push('\nendobj\n');
        };

        const pageCount = pageImages.length;
        const kids = [];
        for (let i = 0; i < pageCount; i++) {
            kids.push(`${3 + i * 3} 0 R`);
        }

        push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
        obj(1, '<< /Type /Catalog /Pages 2 0 R /PageLayout /OneColumn >>');
        obj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`);

        pageImages.forEach((jpg, i) => {
            const pageObj = 3 + i * 3;
            const contentObj = 4 + i * 3;
            const imageObj = 5 + i * 3;

            obj(
                pageObj,
                `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im${i} ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
            );

            const content = `q\n595.28 0 0 841.89 0 0 cm\n/Im${i} Do\nQ\n`;
            obj(contentObj, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`);

            offsets[imageObj] = length;
            push(`${imageObj} 0 obj\n`);
            push(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
            push(jpg);
            push('\nendstream\nendobj\n');
        });

        const objectCount = 2 + pageCount * 3;
        const xref = length;

        push(`xref\n0 ${objectCount + 1}\n`);
        push('0000000000 65535 f \n');
        for (let i = 1; i <= objectCount; i++) {
            push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
        }

        push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);

        const pdfBlob = new Blob(parts, { type: 'application/pdf' });
        const url = URL.createObjectURL(pdfBlob);

        pdfTab.location.replace(url);

        // Keep the object URL alive long enough for browser and mobile PDF viewers.
        setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    };

    const startLongPress = (cafeId) => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);

        longPressCompletedRef.current = false;
        
        setActiveHoldCafe(cafeId);
        setHoldProgress(0);

        const startTime = Date.now();
        progressIntervalRef.current = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min((elapsed / LONG_PRESS_DURATION) * 100, 100);
            setHoldProgress(progress);
        }, 50);

        longPressTimerRef.current = setTimeout(() => {
            if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
            setHoldProgress(100);
            longPressCompletedRef.current = true;
            confirmDeleteCafe(cafeId);
        }, LONG_PRESS_DURATION);
    };

const cancelLongPress = (cafeId) => {
        const wasLongPress = longPressCompletedRef.current;

        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
        }
        setActiveHoldCafe(null);
        setHoldProgress(0);

        // If it wasn't a long press, we treat it as a click and select the cafe
        if (!wasLongPress && cafeId) {
            setSelectedCafe(cafeId);
        }
        longPressCompletedRef.current = false;
    };

    if (!user) {
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-100 dark:bg-amoled transition-opacity p-4">
                <div className="bg-white dark:bg-amoled-card p-6 sm:p-8 rounded-2xl shadow-lg border border-gray-200 dark:border-amoled-border w-full max-w-md">
                    <div className="text-center mb-6 sm:mb-8">
                        <div className="inline-flex items-center justify-center h-14 w-14 sm:h-16 sm:w-16 rounded-full bg-blue-100 dark:bg-blue-900/30 mb-4">
                            <i className="fas fa-building text-primary text-2xl sm:text-3xl"></i>
                        </div>
                        <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">CorpPay Access</h2>
                        <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-1">Please sign in to manage payroll</p>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-4 sm:space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                            <div className="relative rounded-md shadow-sm">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <i className="fas fa-envelope text-gray-400"></i>
                                </div>
                                <input type="email" name="email" required className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-zinc-700 dark:bg-amoled-surface dark:text-white rounded-lg focus:ring-primary focus:border-primary text-sm" />
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                            <div className="relative rounded-md shadow-sm">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <i className="fas fa-lock text-gray-400"></i>
                                </div>
                                <input type="password" name="password" required className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-zinc-700 dark:bg-amoled-surface dark:text-white rounded-lg focus:ring-primary focus:border-primary text-sm" />
                            </div>
                        </div>
                        <button type="submit" className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-primary hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition-colors">
                            Sign In
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="fixed inset-0 flex items-center justify-center bg-gray-100 dark:bg-amoled">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-gray-400">Loading data...</p>
                </div>
            </div>
        );
    }

    // // Schedule Viewer Component
    // const ScheduleViewer = ({ schedule, compact = false }) => {
    //     if (!schedule) return null;
        
    //     return (
    //         <div className={`grid ${compact ? 'grid-cols-7 gap-1' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2'}`}>
    //             {DAYS_OF_WEEK.map(day => {
    //                 const daySchedule = schedule[day];
    //                 if (!daySchedule || daySchedule.shift === 'off') {
    //                     return (
    //                         <div key={day} className={`${compact ? 'p-1' : 'p-2'} rounded text-center text-xs bg-gray-100 dark:bg-gray-800 text-gray-500`}>
    //                             <div className="font-semibold">{DAY_LABELS[day]}</div>
    //                             {!compact && <div className="mt-1">Off</div>}
    //                         </div>
    //                     );
    //                 }
    //                 return (
    //                     <div key={day} className={`${compact ? 'p-1' : 'p-2'} rounded text-center text-xs ${SHIFT_COLORS[daySchedule.shift]} border`}>
    //                         <div className="font-semibold">{DAY_LABELS[day]}</div>
    //                         {!compact && (
    //                             <>
    //                                 <div className="mt-1 font-medium">{SHIFT_TYPES[daySchedule.shift]}</div>
    //                                 {daySchedule.hours && <div className="text-[10px] opacity-75">{daySchedule.hours}</div>}
    //                             </>
    //                         )}
    //                     </div>
    //                 );
    //             })}
    //         </div>
    //     );
    // };

    // Schedule Viewer Component
    const ScheduleViewer = ({ schedule, compact = false }) => {
        if (!schedule) return null;

        const getTimePercent = (time) => {
            const [hours = 0, minutes = 0] = String(time || '00:00').split(':').map(Number);
            return Math.max(0, Math.min(100, ((hours * 60 + minutes) / 1440) * 100));
        };

        if (compact) {
            return (
                <div className="flex flex-wrap gap-1.5">
                    {DAYS_OF_WEEK.map(day => {
                        const daySchedule = schedule[day];
                        const isOff = !daySchedule || daySchedule.shift === 'off';
                        return (
                            <div
                                key={day}
                                title={isOff ? 'Off' : `${SHIFT_TYPES[daySchedule.shift]} (${daySchedule.hours})`}
                                className={`w-6 h-6 sm:w-7 sm:h-7 rounded flex items-center justify-center text-[10px] sm:text-xs font-bold border ${
                                    isOff
                                        ? 'bg-gray-100 text-gray-400 border-gray-200 dark:bg-[#0a0a0a] dark:border-zinc-800/80'
                                        : SHIFT_COLORS[daySchedule.shift]
                                }`}
                            >
                                {DAY_LABELS[day].charAt(0)}
                            </div>
                        );
                    })}
                </div>
            );
        }

        return (
            <div className="flex flex-col gap-2">
                {DAYS_OF_WEEK.map(day => {
                    const daySchedule = schedule[day];
                    const isOff = !daySchedule || daySchedule.shift === 'off';
                    const [startTime = '00:00', endTime = '00:00'] = String(daySchedule?.hours || '').split('-').map(v => v.trim());
                    const startPercent = getTimePercent(startTime);
                    const endPercent = getTimePercent(endTime);
                    const widthPercent = Math.max(3, endPercent >= startPercent ? endPercent - startPercent : 100 - startPercent + endPercent);

                    return (
                        <div
                            key={day}
                            className="p-2.5 rounded-lg border border-gray-100 dark:border-zinc-800/60 bg-gray-50/50 dark:bg-[#0a0a0a]/50 hover:bg-gray-50 dark:hover:bg-[#111] transition-colors"
                        >
                            <div className="flex justify-between items-center gap-2">
                                <div className="font-medium text-sm text-gray-700 dark:text-gray-300 w-12 shrink-0">
                                    {DAY_LABELS[day]}
                                </div>

                                {isOff ? (
                                    <div className="text-[11px] text-gray-400 dark:text-zinc-500 font-medium px-2 py-1 bg-gray-100 dark:bg-zinc-800/50 rounded-md border border-transparent">
                                        Day Off
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className="text-xs text-gray-500 font-medium tracking-wide whitespace-nowrap">
                                            {startTime} - {endTime}
                                        </div>
                                        <div className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border w-20 text-center ${SHIFT_COLORS[daySchedule.shift]}`}>
                                            {SHIFT_TYPES[daySchedule.shift]}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {!isOff && (
                                <div className="mt-2 ml-12">
                                    <div className="h-1.5 rounded-full bg-gray-200/70 dark:bg-zinc-800/80 relative overflow-hidden">
                                        {endPercent >= startPercent ? (
                                            <div
                                                className={`absolute top-0 h-full rounded-full ${SHIFT_COLORS[daySchedule.shift]}`}
                                                style={{ left: `${startPercent}%`, width: `${widthPercent}%` }}
                                            ></div>
                                        ) : (
                                            <>
                                                <div
                                                    className={`absolute top-0 h-full rounded-full ${SHIFT_COLORS[daySchedule.shift]}`}
                                                    style={{ left: `${startPercent}%`, width: `${100 - startPercent}%` }}
                                                ></div>
                                                <div
                                                    className={`absolute top-0 h-full rounded-full ${SHIFT_COLORS[daySchedule.shift]}`}
                                                    style={{ left: '0%', width: `${endPercent}%` }}
                                                ></div>
                                            </>
                                        )}
                                    </div>
                                    <div className="mt-1 flex justify-between text-[9px] text-gray-400 dark:text-zinc-600">
                                        <span>00</span>
                                        <span>06</span>
                                        <span>12</span>
                                        <span>18</span>
                                        <span>24</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    };

    // Schedule Editor Modal
    const ScheduleEditorModal = () => {
        if (!isScheduleOpen) return null;
        
        const employee = employees.find(e => e.id === selectedEmployeeId);
        if (!employee) return null;
        
        const cafe = cafes.find(c => c.id === employee.cafeId);
        
        const updateDaySchedule = (day, field, value) => {
            setEditingSchedule(prev => ({
                ...prev,
                [day]: {
                    ...prev[day],
                    [field]: value
                }
            }));
        };
        
        return (
            <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-3 sm:p-4 fade-in">
                <div className="bg-white dark:bg-amoled-card rounded-xl shadow-2xl border dark:border-zinc-800 w-full max-w-4xl max-h-[95vh] flex flex-col overflow-hidden">
                    <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-200 dark:border-amoled-border flex justify-between items-center bg-gray-50 dark:bg-[#0a0a0a]">
                        <div>
                            <h3 className="text-base sm:text-lg font-medium dark:text-white">Edit Schedule</h3>
                            <p className="text-xs sm:text-sm text-gray-500">{employee.name} • {cafe?.name}</p>
                        </div>
                        <button onClick={() => setIsScheduleOpen(false)} className="text-gray-400 hover:text-gray-600 p-1">
                            <i className="fas fa-times text-xl"></i>
                        </button>
                    </div>
                    
                    <div className="p-4 sm:p-6 overflow-y-auto flex-grow space-y-4 sm:space-y-6">
                        {DAYS_OF_WEEK.map(day => (
                            <div key={day} className="border border-gray-200 dark:border-amoled-border rounded-lg p-3 sm:p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h4 className="font-semibold text-gray-900 dark:text-white capitalize text-sm sm:text-base">{day}</h4>
                                    <select
                                        value={editingSchedule[day]?.shift || 'off'}
                                        onChange={(e) => updateDaySchedule(day, 'shift', e.target.value)}
                                        className="text-sm border rounded-md px-2 sm:px-3 py-1.5 dark:bg-amoled-surface dark:border-zinc-700 dark:text-white"
                                    >
                                        {Object.entries(SHIFT_TYPES).map(([key, label]) => (
                                            <option key={key} value={key}>{label}</option>
                                        ))}
                                    </select>
                                </div>
                                
                                {editingSchedule[day]?.shift !== 'off' && (
                                    <div className="grid grid-cols-2 gap-3 sm:gap-4">
                       <div>
                                            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
                                            <select
                                                value={editingSchedule[day]?.hours?.split('-')[0] || '09:00'}
                                                onChange={(e) => {
                                                    const end = editingSchedule[day]?.hours?.split('-')[1] || '18:00';
                                                    updateDaySchedule(day, 'hours', `${e.target.value}-${end}`);
                                                }}
                                                className="w-full border rounded-md px-2 sm:px-3 py-2 text-sm dark:bg-amoled-surface dark:border-zinc-700 dark:text-white focus:ring-primary focus:border-primary"
                                            >
                                                {Array.from({length: 17}, (_, i) => {
                                                    const hour = String(i + 7).padStart(2, '0') + ':00';
                                                    return <option key={hour} value={hour}>{hour}</option>
                                                })}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-xs text-gray-500 mb-1">End Time</label>
                                            <select
                                                value={editingSchedule[day]?.hours?.split('-')[1] || '18:00'}
                                                onChange={(e) => {
                                                    const start = editingSchedule[day]?.hours?.split('-')[0] || '09:00';
                                                    updateDaySchedule(day, 'hours', `${start}-${e.target.value}`);
                                                }}
                                                className="w-full border rounded-md px-2 sm:px-3 py-2 text-sm dark:bg-amoled-surface dark:border-zinc-700 dark:text-white focus:ring-primary focus:border-primary"
                                            >
                                                {Array.from({length: 17}, (_, i) => {
                                                    const hour = String(i + 7).padStart(2, '0') + ':00';
                                                    return <option key={hour} value={hour}>{hour}</option>
                                                })}
                                            </select>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    
                    <div className="bg-gray-50 dark:bg-[#0a0a0a] px-4 sm:px-6 py-3 border-t dark:border-amoled-border flex justify-end gap-2 sm:gap-3">
                        <button 
                            onClick={() => setIsScheduleOpen(false)}
                            className="px-3 sm:px-4 py-2 border rounded-md dark:border-zinc-700 dark:bg-amoled-surface dark:text-gray-300 text-sm"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleScheduleSave}
                            className="px-3 sm:px-4 py-2 bg-primary text-white rounded-md font-medium text-sm"
                        >
                            <i className="fas fa-save mr-2"></i>Save Schedule
                        </button>
                    </div>
                </div>
            </div>
        );
    };

   
const CafeSelector = () => (
        <div className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border p-3 sm:p-4 mb-4 sm:mb-6">
            <div className="flex justify-between items-center mb-3">
                <h3 className="text-xs sm:text-sm font-semibold text-gray-700 dark:text-gray-300">Select Cafe Location</h3>
                <div className="flex gap-2">
                    {/* Delete Button - Only shows when a specific cafe is selected */}
                    {selectedCafe !== 'all' && (
                        <button 
                            onClick={() => confirmDeleteCafe(selectedCafe)}
                            className="p-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors shadow-sm"
                            title="Delete Selected Cafe"
                        >
                            <i className="fas fa-trash-alt text-sm"></i>
                        </button>
                    )}
                  <button 
                        onClick={() => setIsAddCafeOpen(true)}
                        className="p-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-all shadow-sm"
                        title="Add New Cafe"
                    >
                        <i className="fas fa-plus text-sm"></i>
                    </button>
                </div>
            </div>
            <div className="flex flex-wrap gap-2">
                <button
                    onClick={() => setSelectedCafe('all')}
                    className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs font-medium transition-all duration-200 transform hover:scale-105 ${
                        selectedCafe === 'all'
                            ? 'bg-primary text-white shadow-md scale-105'
                            : 'bg-gray-100 dark:bg-amoled-surface text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-zinc-800'
                    }`}
                >
                    All Cafes
                </button>
                {cafes.map((cafe) => {
                    const isSelected = selectedCafe === cafe.id;
                    
                    return (
                        <button
                            key={cafe.id}
                            onClick={() => setSelectedCafe(cafe.id)}
                            className={`relative overflow-hidden px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs font-medium transition-all duration-200 transform hover:scale-105 select-none ${
                                isSelected
                                    ? `${cafe.color} text-white shadow-md scale-105`
                                    : 'bg-gray-100 dark:bg-amoled-surface text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-zinc-800'
                            }`}
                            style={{ cursor: 'pointer', touchAction: 'manipulation' }}
                        >
                            <span className="relative z-10">{cafe.name}</span>
                        </button>
                    );
                })}
            </div>
            {selectedCafe !== 'all' && (
                <div className="mt-2 text-xs sm:text-sm text-gray-600 dark:text-gray-400">
                    Showing: <span className="font-semibold text-primary">{cafes.find(c => c.id === selectedCafe)?.name}</span>
                </div>
            )}
        </div>
    );


    const AddCafeModal = () => {
        if (!isAddCafeOpen) return null;
        
        return (
            <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-[200] fade-in p-4">
                <div className="relative overflow-hidden bg-white/70 dark:bg-[#0b1018]/82 backdrop-blur-3xl p-6 sm:p-7 rounded-[30px] w-full max-w-md border border-white/45 dark:border-white/10 shadow-[0_30px_100px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.16)]">
                    <h3 className="text-lg font-bold mb-4 dark:text-white">Add New Cafe</h3>
                    <form onSubmit={handleAddCafe} className="space-y-4">
                        <div>
                            <label className="block text-sm dark:text-gray-300 mb-1">Cafe Name</label>
                            <input name="name" required placeholder="e.g., Новый Кафе" className="w-full border p-2 rounded dark:bg-amoled-surface dark:border-zinc-700 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm dark:text-gray-300 mb-1">Location (Optional)</label>
                            <input name="location" placeholder="e.g., Downtown, Mall" className="w-full border p-2 rounded dark:bg-amoled-surface dark:border-zinc-700 dark:text-white" />
                        </div>
                        <div className="flex justify-end gap-2 pt-4">
                            <button type="button" onClick={() => setIsAddCafeOpen(false)} className="px-4 py-2 border rounded dark:border-zinc-700 dark:text-gray-300 text-sm">Cancel</button>
                            <button type="submit" disabled={isAddingCafe} className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded text-sm">{isAddingCafe ? <><i className="fas fa-spinner fa-spin mr-2"></i>Adding...</> : <><i className="fas fa-plus mr-2"></i>Add Cafe</>}</button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    const DeleteCafeModal = () => {
        if (!isDeleteCafeOpen) return null;
        
        const cafe = cafes.find(c => c.id === cafeToDelete);
        const employeeCount = employees.filter(emp => emp.cafeId === cafeToDelete).length;
        
        return (
            <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 fade-in p-4">
                <div className="bg-white dark:bg-amoled-card p-5 sm:p-6 rounded-lg w-full max-w-md border dark:border-zinc-800 shadow-xl">
                    <div className="text-center mb-4">
                        <div className="mx-auto flex items-center justify-center h-14 w-14 sm:h-16 sm:w-16 rounded-full bg-red-100 dark:bg-red-900/30 mb-4">
                            <i className="fas fa-exclamation-triangle text-red-600 text-2xl sm:text-3xl"></i>
                        </div>
                        <h3 className="text-lg sm:text-xl font-bold mb-2 dark:text-white">Warning: Delete Cafe</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            You are about to delete <strong>{cafe?.name}</strong>
                        </p>
                    </div>
                    
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 sm:p-4 mb-6">
                        <p className="text-sm text-red-800 dark:text-red-400 font-medium mb-2">
                            <i className="fas fa-info-circle mr-2"></i>
                            Important Information:
                        </p>
                        <ul className="text-xs text-red-700 dark:text-red-300 space-y-1 list-disc list-inside">
                            <li>This action cannot be undone</li>
                            <li>{employeeCount > 0 ? `This cafe has ${employeeCount} employee(s) assigned` : 'No employees currently assigned'}</li>
                            <li>All employee schedules and records will be affected</li>
                            <li>You must reassign or remove all employees before deletion</li>
                        </ul>
                    </div>
                    
                    {employeeCount > 0 && (
                        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 mb-6">
                            <p className="text-sm text-yellow-800 dark:text-yellow-400">
                                <i className="fas fa-exclamation-circle mr-2"></i>
                                Please reassign or remove all {employeeCount} employee(s) from this cafe before deleting.
                            </p>
                        </div>
                    )}
                    
                    <div className="flex justify-center gap-3">
                        <button 
                            type="button"
                            disabled={isDeletingCafe}
                            onClick={() => {
                                if (isDeletingCafe) return;
                                setIsDeleteCafeOpen(false);
                                setCafeToDelete(null);
                                setActiveHoldCafe(null);
                                setHoldProgress(0);
                            }}
                            className="px-4 py-2 border rounded dark:border-zinc-700 dark:text-gray-300 text-sm"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleDeleteCafe}
                            disabled={employeeCount > 0 || isDeletingCafe}
                            className={`px-4 py-2 rounded font-medium text-sm ${
                                employeeCount > 0 
                                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
                                    : 'bg-red-600 hover:bg-red-700 text-white'
                            }`}
                        >
                            {isDeletingCafe ? <><i className="fas fa-spinner fa-spin mr-2"></i>Deleting...</> : <><i className="fas fa-trash-alt mr-2"></i>Delete Cafe</>}
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    const renderRoles = () => {
        const activeCount = employees.filter(emp => emp.status === 'active').length;
        return (
            <div className="space-y-5 sm:space-y-6 fade-in">
                <div className="relative overflow-hidden rounded-3xl border border-white/20 dark:border-white/10 bg-white/60 dark:bg-white/[0.035] backdrop-blur-2xl shadow-xl shadow-black/[0.03] dark:shadow-black/20 p-5 sm:p-7">
                    <div className="pointer-events-none absolute -top-20 -right-16 h-52 w-52 rounded-full bg-primary/20 blur-3xl"></div>
                    <div className="pointer-events-none absolute -bottom-20 left-1/3 h-48 w-48 rounded-full bg-purple-500/15 blur-3xl"></div>
                    <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-primary"><i className="fas fa-layer-group"></i> Role Library</div>
                            <h1 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Roles & Salary Presets</h1>
                            <p className="mt-2 max-w-2xl text-sm text-gray-500 dark:text-gray-400">Create reusable roles once. When you hire or manage an employee, choosing a saved role instantly brings in its salary.</p>
                        </div>
                        <button type="button" onClick={() => { if (!isSavingRole && !isDeletingRole) { setNewRoleName(''); setNewRoleSalary(''); setIsAddingRole(true); } }} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-primary/25 transition hover:-translate-y-0.5 hover:bg-primary/90"><i className="fas fa-plus"></i> Add Role</button>
                    </div>
                    <div className="relative mt-6 grid grid-cols-2 sm:flex sm:items-center gap-3 text-sm">
                        <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/50 dark:bg-black/20 px-4 py-3 backdrop-blur-xl"><div className="text-[11px] uppercase tracking-wider text-gray-400">Saved Roles</div><div className="mt-1 text-xl font-bold dark:text-white">{roles.length}</div></div>
                        <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/50 dark:bg-black/20 px-4 py-3 backdrop-blur-xl"><div className="text-[11px] uppercase tracking-wider text-gray-400">Active Team</div><div className="mt-1 text-xl font-bold dark:text-white">{activeCount}</div></div>
                    </div>
                </div>

                {roles.length === 0 ? <div className="rounded-3xl border border-dashed border-gray-300 dark:border-zinc-700 bg-white/60 dark:bg-white/[0.025] backdrop-blur-xl p-10 text-center"><div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"><i className="fas fa-briefcase text-2xl"></i></div><h3 className="font-bold dark:text-white">Your role library is empty</h3><p className="mt-1 text-sm text-gray-500">Add your first role and salary preset.</p></div> : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5">
                        {roles.map(role => {
                            const assigned = employees.filter(emp => emp.status === 'active' && String(emp.role || '').trim().toLowerCase() === String(role.name || '').trim().toLowerCase()).length;
                            return <div key={role.id} className="group relative overflow-hidden rounded-3xl border border-white/40 dark:border-white/10 bg-white/65 dark:bg-white/[0.035] p-5 backdrop-blur-2xl shadow-lg shadow-black/[0.025] transition duration-300 hover:-translate-y-1 hover:shadow-xl dark:hover:bg-white/[0.055]">
                                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent"></div>
                                <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-purple-500/20 text-primary ring-1 ring-white/40 dark:ring-white/10"><i className="fas fa-briefcase"></i></div><div className="min-w-0"><h3 className="truncate font-bold text-gray-900 dark:text-white">{role.name}</h3><p className="mt-0.5 text-xs text-gray-500">{assigned} active employee{assigned === 1 ? '' : 's'}</p></div></div><button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDeleteRoleModal(role); }} className="relative z-20 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-red-500/15 bg-red-500/5 text-red-500 transition hover:bg-red-500 hover:text-white active:scale-95" title="Delete role" aria-label={`Delete ${role.name}`}><i className="fas fa-minus pointer-events-none"></i></button></div>
                                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openEditRoleModal(role); }} className="relative z-20 mt-5 flex w-full cursor-pointer items-center justify-between rounded-2xl border border-gray-200/70 dark:border-white/10 bg-white/55 dark:bg-black/20 px-4 py-3 text-left transition hover:border-primary/40 hover:bg-primary/[0.04] active:scale-[0.99]" title={`Edit ${role.name} salary`}><div><div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Default Salary</div><div className="mt-1 font-bold text-gray-900 dark:text-white">{formatMoney(role.salary || 0)}</div></div><i className="fas fa-pen text-xs text-primary"></i></button>
                            </div>;
                        })}
                    </div>
                )}
            </div>
        );
    };

const renderDashboard = () => {
        const filteredEmployees = getFilteredEmployees(employees.filter(e => e.status === 'active'));
        let grandTotalPay = 0; 
        let grandTotalDeductions = 0; 
        let activeEmployees = 0;
        
        // Figure out what day it is today to show the roster
        const todayIndex = new Date().getDay();
        const todayName = DAYS_OF_WEEK[todayIndex === 0 ? 6 : todayIndex - 1];
        const workingToday = filteredEmployees.filter(emp => emp.schedule && emp.schedule[todayName] && emp.schedule[todayName].shift !== 'off');
        
        const averagePay = activeEmployees ? 0 : 0; // recalculated after payroll aggregation below
        const roleCount = new Set(filteredEmployees.map(emp => String(emp.role || '').trim()).filter(Boolean)).size;
        const locationCount = new Set(filteredEmployees.map(emp => emp.cafeId).filter(Boolean)).size;
        const workingPercent = activeEmployees ? 0 : 0; // recalculated after aggregation below

        const employeeRows = filteredEmployees.map(emp => {
            activeEmployees++;
            const payInfo = calculatePay(emp, selectedMonth, null, logs);
            grandTotalPay += payInfo.net;
            grandTotalDeductions += payInfo.deductions;
            const cafe = cafes.find(c => c.id === emp.cafeId);
            
            return (
                <tr key={emp.id} className="hover:bg-gray-50 dark:hover:bg-amoled-surface transition-colors">
                    <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap">
                        <div className="flex items-center">
                           <div className={`flex-shrink-0 h-9 w-9 sm:h-10 sm:w-10 rounded-full ${cafe?.color || 'bg-gray-500'} bg-opacity-80 bg-blend-overlay shadow-inner flex items-center justify-center text-white font-bold text-sm sm:text-base ring-1 ring-white/10`}>
                                {emp.profilePic ? <img src={emp.profilePic} alt={emp.name} className="h-full w-full rounded-full object-cover" /> : emp.name.charAt(0)}
                            </div>
                            <div className="ml-3 sm:ml-4">
                                <div className="text-xs sm:text-sm font-medium text-gray-900 dark:text-white">{emp.name}</div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">{emp.role} • {cafe?.name}</div>
                            </div>
                        </div>
                    </td>
                    <td className="hidden sm:table-cell px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{formatMoney(payInfo.base)}</td>
                    <td className="hidden sm:table-cell px-6 py-4 whitespace-nowrap text-sm text-danger dark:text-red-400">{payInfo.deductions > 0 ? '-' + formatMoney(payInfo.deductions) : formatMoney(0)}</td>
                    <td className="hidden md:table-cell px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900 dark:text-white">{formatMoney(payInfo.net)}</td>
                    <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap text-right text-xs sm:text-sm font-medium space-x-1 sm:space-x-2">
                        <button 
                            onClick={(e) => {
                                e.stopPropagation();
                                openScheduleEditor(emp);
                            }}
                            className="text-purple-600 dark:text-purple-400 hover:text-purple-900 bg-purple-50 dark:bg-purple-900/20 px-2 sm:px-3 py-1 rounded-md transition-colors border border-purple-200 dark:border-purple-800"
                            title="View/Edit Schedule"
                        >
                            <i className="fas fa-calendar-alt"></i>
                        </button>
                        <button 
                            onClick={(e) => {
                                e.stopPropagation();
                                openEmployeeDetail(emp.id, selectedMonth);
                            }}
                            className="text-primary dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 bg-blue-50 dark:bg-blue-900/20 px-2 sm:px-3 py-1 rounded-md transition-colors border border-blue-200 dark:border-blue-800"
                        >
                            Manage
                        </button>
                    </td>
                </tr>
            );
        });

        const averageNetPay = activeEmployees ? grandTotalPay / activeEmployees : 0;
        const scheduledPercent = activeEmployees ? Math.round((workingToday.length / activeEmployees) * 100) : 0;

        return (
            <div className="space-y-4 sm:space-y-6 corp-glass-enter">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 sm:gap-4">
                    <div>
                        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Payroll Overview</h1>
                        <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-1">
                            {selectedCafe === 'all' ? 'All Locations' : cafes.find(c => c.id === selectedCafe)?.name}
                        </p>
                    </div>
                  <div className="w-full sm:w-auto z-40"><ModernDropdown value={selectedMonth} onChange={setSelectedMonth} options={generateMonthOptions()} /></div>
                </div>
                
                <CafeSelector />
                
                {/* Premium Bento Analytics — additive; timeline below is preserved */}
                <div className="relative overflow-hidden rounded-[30px] border border-white/35 dark:border-white/10 bg-white/45 dark:bg-[#0b0f16]/70 p-4 sm:p-5 lg:p-6 shadow-[0_22px_70px_rgba(0,0,0,0.10)] dark:shadow-[0_24px_90px_rgba(0,0,0,0.38)] backdrop-blur-2xl">
                    <div className="pointer-events-none absolute -left-16 -top-20 h-64 w-64 rounded-full bg-blue-500/12 blur-3xl"></div>
                    <div className="pointer-events-none absolute -right-16 -bottom-24 h-72 w-72 rounded-full bg-violet-500/10 blur-3xl"></div>

                    <div className="relative mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-primary backdrop-blur-xl">
                                <i className="fas fa-chart-pie"></i> Live Payroll Snapshot
                            </div>
                            <h2 className="mt-3 text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">Payroll at a glance</h2>
                            <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">A quick, calm overview before you dive into today's schedule.</p>
                        </div>
                        <div className="inline-flex w-fit items-center gap-2 rounded-2xl border border-white/35 bg-white/45 px-3 py-2 text-xs font-semibold text-gray-600 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.045] dark:text-gray-300">
                            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
                            {workingToday.length} on duty today
                        </div>
                    </div>

                    <div className="relative grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12">
                        <div className="lg:col-span-5 group relative overflow-hidden rounded-[24px] border border-white/45 bg-gradient-to-br from-blue-500/[0.13] via-primary/[0.08] to-violet-500/[0.10] p-5 sm:p-6 shadow-lg backdrop-blur-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl dark:border-blue-300/15">
                            <div className="absolute -right-8 -top-8 h-36 w-36 rounded-full bg-blue-400/20 blur-3xl transition duration-500 group-hover:scale-125"></div>
                            <div className="relative flex items-start justify-between">
                                <div>
                                    <p className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">Total Payroll</p>
                                    <h3 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white">{formatMoney(grandTotalPay)}</h3>
                                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Net payroll for the selected month</p>
                                </div>
                                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/15 text-primary shadow-inner backdrop-blur-xl">
                                    <i className="fas fa-wallet text-lg"></i>
                                </div>
                            </div>
                        </div>

                        <div className="lg:col-span-3 rounded-[24px] border border-white/40 bg-white/45 p-5 shadow-sm backdrop-blur-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-xl dark:border-white/[0.09] dark:bg-white/[0.04]">
                            <div className="flex items-center justify-between">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">Active Team</p>
                                <i className="fas fa-users text-primary/80"></i>
                            </div>
                            <div className="mt-4 text-3xl font-bold text-gray-900 dark:text-white">{activeEmployees}</div>
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{roleCount} saved role{roleCount === 1 ? '' : 's'} in use</p>
                        </div>

                        <div className="lg:col-span-4 rounded-[24px] border border-red-300/25 bg-gradient-to-br from-red-500/[0.08] to-rose-500/[0.04] p-5 shadow-sm backdrop-blur-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-xl dark:border-red-400/15">
                            <div className="flex items-center justify-between">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-red-600/80 dark:text-red-300/75">Total Deductions</p>
                                <i className="fas fa-file-invoice text-red-500/80"></i>
                            </div>
                            <div className="mt-4 text-3xl font-bold text-gray-900 dark:text-red-50">{formatMoney(grandTotalDeductions)}</div>
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Across the selected payroll period</p>
                        </div>

                        <div className="lg:col-span-4 rounded-[22px] border border-white/40 bg-white/40 p-4 sm:p-5 backdrop-blur-xl transition-all duration-300 hover:bg-white/55 dark:border-white/[0.08] dark:bg-black/15 dark:hover:bg-white/[0.055]">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Today's coverage</p>
                                    <div className="mt-2 flex items-baseline gap-2"><span className="text-2xl font-bold text-gray-900 dark:text-white">{scheduledPercent}%</span><span className="text-xs text-gray-500">scheduled</span></div>
                                </div>
                                <div className="h-11 w-11 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 flex items-center justify-center text-emerald-500"><i className="fas fa-calendar-check"></i></div>
                            </div>
                            <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-200/70 dark:bg-white/[0.07]"><div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-all duration-700" style={{ width: `${scheduledPercent}%` }}></div></div>
                        </div>

                        <div className="lg:col-span-4 rounded-[22px] border border-white/40 bg-white/40 p-4 sm:p-5 backdrop-blur-xl transition-all duration-300 hover:bg-white/55 dark:border-white/[0.08] dark:bg-black/15 dark:hover:bg-white/[0.055]">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Average net pay</p>
                                    <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{formatMoney(averageNetPay)}</div>
                                </div>
                                <div className="h-11 w-11 rounded-2xl border border-violet-400/20 bg-violet-500/10 flex items-center justify-center text-violet-500"><i className="fas fa-chart-line"></i></div>
                            </div>
                            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Per active employee</p>
                        </div>

                        <div className="lg:col-span-4 rounded-[22px] border border-white/40 bg-white/40 p-4 sm:p-5 backdrop-blur-xl transition-all duration-300 hover:bg-white/55 dark:border-white/[0.08] dark:bg-black/15 dark:hover:bg-white/[0.055]">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Locations</p>
                                    <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{locationCount}</div>
                                </div>
                                <div className="h-11 w-11 rounded-2xl border border-amber-400/20 bg-amber-500/10 flex items-center justify-center text-amber-500"><i className="fas fa-store"></i></div>
                            </div>
                            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Included in this view</p>
                        </div>
                    </div>
                </div>

                {/* 7-day Schedule Timeline — additive replacement for the old single-day view */}
                {(() => {
                    const baseDate = new Date();
                    baseDate.setHours(12, 0, 0, 0);
                    baseDate.setDate(baseDate.getDate() + timelineOffset);

                    const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                    const dayNameForDate = (d) => DAYS_OF_WEEK[(d.getDay() + 6) % 7];
                    const formatDay = (d) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
                    const compactDay = (d) => new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
                    const isSameDate = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

                    const selectedDayName = dayNameForDate(baseDate);
                    const selectedWorking = filteredEmployees.filter(emp =>
                        emp.schedule && emp.schedule[selectedDayName] && emp.schedule[selectedDayName].shift !== 'off'
                    );

                    const sevenDays = Array.from({ length: 7 }, (_, i) => {
                        const d = new Date(baseDate);
                        d.setDate(baseDate.getDate() + i - 3);
                        const dn = dayNameForDate(d);
                        const scheduled = filteredEmployees.filter(emp =>
                            emp.schedule && emp.schedule[dn] && emp.schedule[dn].shift !== 'off'
                        ).length;
                        return { date: d, scheduled };
                    });

                    const toMinutes = (time) => {
                        const [h = '0', m = '0'] = String(time || '').split(':');
                        return Number(h) * 60 + Number(m);
                    };
                    const selectedDateLabel = isSameDate(baseDate, new Date())
                        ? `Today · ${formatDay(baseDate)}`
                        : formatDay(baseDate);

                    const dayStart = 8 * 60;
                    const dayEnd = 23 * 60;
                    const totalRange = dayEnd - dayStart;

                    // Useful planning insight: maximum number of people simultaneously on duty.
                    const hourlyCounts = Array.from({ length: 16 }, (_, i) => {
                        const minute = (8 + i) * 60;
                        return selectedWorking.filter(emp => {
                            const hours = emp.schedule?.[selectedDayName]?.hours || '';
                            const [a, b] = hours.split('-').map(v => v.trim());
                            return a && b && toMinutes(a) <= minute && toMinutes(b) > minute;
                        }).length;
                    });
                    const peakCount = hourlyCounts.length ? Math.max(...hourlyCounts) : 0;
                    const peakHourIndex = hourlyCounts.indexOf(peakCount);
                    const peakHour = peakCount > 0 ? `${String(8 + peakHourIndex).padStart(2, '0')}:00` : '—';

                    const moveTimeline = (direction) => {
                        setTimelineOffset(prev => Math.max(-365, Math.min(365, prev + direction)));
                    };

                    return (
                        <div
                            className="relative overflow-hidden rounded-[28px] border border-white/40 dark:border-white/10 bg-white/55 dark:bg-[#0d1118]/72 shadow-[0_18px_60px_rgba(0,0,0,0.08)] dark:shadow-[0_22px_70px_rgba(0,0,0,0.42)] backdrop-blur-2xl mb-4 sm:mb-6 transition-all duration-300 hover:shadow-[0_24px_78px_rgba(0,0,0,0.14)]"
                            onTouchStart={(e) => {
                                const t = e.touches[0];
                                timelineTouchRef.current = { x: t.clientX, y: t.clientY };
                            }}
                            onTouchEnd={(e) => {
                                const t = e.changedTouches[0];
                                const dx = t.clientX - timelineTouchRef.current.x;
                                const dy = t.clientY - timelineTouchRef.current.y;
                                if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) moveTimeline(dx < 0 ? 1 : -1);
                            }}
                        >
                            <div className="pointer-events-none absolute -left-20 top-0 h-40 w-40 rounded-full bg-blue-500/10 blur-3xl"></div>
                            <div className="pointer-events-none absolute right-0 -bottom-24 h-48 w-48 rounded-full bg-violet-500/10 blur-3xl"></div>

                            <div className="relative bg-gradient-to-r from-blue-500/[0.08] via-indigo-500/[0.05] to-violet-500/[0.08] px-4 sm:px-6 py-4 border-b border-white/35 dark:border-white/[0.08] backdrop-blur-xl">
                                <div className="flex flex-col gap-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <h3 className="font-semibold text-sm sm:text-base text-indigo-900 dark:text-indigo-300">
                                                    <i className="fas fa-calendar-week mr-2"></i>Team Schedule
                                                </h3>
                                                {timelineOffset !== 0 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => setTimelineOffset(0)}
                                                        className="text-[10px] font-bold text-primary hover:text-blue-400 transition-colors"
                                                    >
                                                        Back to today
                                                    </button>
                                                )}
                                            </div>
                                            <p className="text-[10px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                                Swipe or use the arrows to look back and plan ahead.
                                            </p>
                                        </div>

                                        <div className="hidden sm:flex items-center gap-2">
                                            <button type="button" onClick={() => moveTimeline(-1)} aria-label="Previous day" className="h-9 w-9 rounded-xl border border-white/40 dark:border-white/10 bg-white/45 dark:bg-white/[0.045] text-gray-600 dark:text-gray-200 hover:border-primary/50 hover:text-primary transition-all hover:-translate-x-0.5">
                                                <i className="fas fa-chevron-left text-xs"></i>
                                            </button>
                                            <div className="min-w-[175px] text-center rounded-xl border border-white/40 dark:border-white/10 bg-white/40 dark:bg-black/10 px-3 py-2 backdrop-blur-xl">
                                                <div className="text-xs font-bold text-gray-900 dark:text-white">{selectedDateLabel}</div>
                                                <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{selectedWorking.length} scheduled · peak {peakCount} at {peakHour}</div>
                                            </div>
                                            <button type="button" onClick={() => moveTimeline(1)} aria-label="Next day" className="h-9 w-9 rounded-xl border border-white/40 dark:border-white/10 bg-white/45 dark:bg-white/[0.045] text-gray-600 dark:text-gray-200 hover:border-primary/50 hover:text-primary transition-all hover:translate-x-0.5">
                                                <i className="fas fa-chevron-right text-xs"></i>
                                            </button>
                                        </div>
                                    </div>

                                    {/* Scrollable 7-day strip */}
                                    <div className="flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                        {sevenDays.map(({ date, scheduled }) => {
                                            const active = isSameDate(date, baseDate);
                                            const today = isSameDate(date, new Date());
                                            return (
                                                <button
                                                    key={dateKey(date)}
                                                    type="button"
                                                    onClick={() => {
                                                        const todayDate = new Date();
                                                        todayDate.setHours(12, 0, 0, 0);
                                                        setTimelineOffset(Math.round((date - todayDate) / 86400000));
                                                    }}
                                                    className={`snap-start shrink-0 min-w-[94px] rounded-2xl border px-3 py-2.5 text-left transition-all duration-300 ${
                                                        active
                                                            ? 'border-primary/55 bg-primary/15 shadow-[0_8px_28px_rgba(59,130,246,0.18)] scale-[1.02]'
                                                            : 'border-white/35 dark:border-white/[0.08] bg-white/35 dark:bg-white/[0.035] hover:bg-white/60 dark:hover:bg-white/[0.07]'
                                                    }`}
                                                >
                                                    <div className={`text-[10px] font-bold uppercase tracking-wide ${active ? 'text-primary' : 'text-gray-500 dark:text-gray-400'}`}>
                                                        {today ? 'Today' : compactDay(date)}
                                                    </div>
                                                    <div className="mt-1 text-sm font-bold text-gray-900 dark:text-white">{date.getDate()}</div>
                                                    <div className="mt-1 flex items-center gap-1 text-[9px] text-gray-500 dark:text-gray-400">
                                                        <span className={`h-1.5 w-1.5 rounded-full ${scheduled ? 'bg-emerald-400' : 'bg-gray-400/50'}`}></span>
                                                        {scheduled} on duty
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>

                                    <div className="flex sm:hidden items-center justify-between gap-2">
                                        <button type="button" onClick={() => moveTimeline(-1)} className="flex-1 rounded-xl border border-white/35 dark:border-white/10 bg-white/40 dark:bg-white/[0.04] py-2 text-xs font-semibold text-gray-700 dark:text-gray-200 active:scale-[0.98]">
                                            <i className="fas fa-chevron-left mr-2 text-[10px]"></i>Previous
                                        </button>
                                        <div className="text-center text-[10px] text-gray-500 dark:text-gray-400 whitespace-nowrap">{selectedDateLabel}</div>
                                        <button type="button" onClick={() => moveTimeline(1)} className="flex-1 rounded-xl border border-white/35 dark:border-white/10 bg-white/40 dark:bg-white/[0.04] py-2 text-xs font-semibold text-gray-700 dark:text-gray-200 active:scale-[0.98]">
                                            Next<i className="fas fa-chevron-right ml-2 text-[10px]"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="relative p-3 sm:p-5">
                                {selectedWorking.length === 0 ? (
                                    <div className="text-center py-10">
                                        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/40 dark:bg-white/[0.04] border border-white/30 dark:border-white/10">
                                            <i className="fas fa-calendar-xmark text-lg text-gray-400"></i>
                                        </div>
                                        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">No one is scheduled for {formatDay(baseDate)}.</p>
                                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Use the arrows or swipe to check another day.</p>
                                    </div>
                                ) : (
                                    <div className="overflow-x-auto pb-2">
                                        <div className="min-w-[760px]">
                                            <div className="grid grid-cols-[210px_1fr] mb-3">
                                                <div className="text-[10px] uppercase tracking-wider font-semibold text-gray-400 dark:text-gray-500 px-1">Team member</div>
                                                <div className="relative h-8 border-b border-gray-200 dark:border-zinc-800">
                                                    {Array.from({ length: 16 }, (_, i) => {
                                                        const hour = 8 + i;
                                                        const position = (i / 15) * 100;
                                                        return (
                                                            <div key={hour} className="absolute top-0 flex flex-col items-center" style={{ left: `${position}%`, transform: i === 0 ? 'translateX(0)' : i === 15 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                                                                <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">{String(hour).padStart(2, '0')}:00</span>
                                                                <span className="w-px h-2 bg-gray-300 dark:bg-zinc-700 mt-1"></span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>

                                            <div className="space-y-2 corp-timeline-slide" key={dateKey(baseDate)}>
                                                {selectedWorking.map((emp, index) => {
                                                    const cafe = cafes.find(c => c.id === emp.cafeId);
                                                    const hours = emp.schedule?.[selectedDayName]?.hours || '';
                                                    const [startTime = '09:00', endTime = '18:00'] = hours.split('-').map(v => v.trim());
                                                    const rawStart = toMinutes(startTime);
                                                    const rawEnd = toMinutes(endTime);
                                                    const safeStart = Math.max(dayStart, Math.min(rawStart, dayEnd));
                                                    const safeEnd = Math.max(safeStart + 30, Math.min(rawEnd, dayEnd));
                                                    const left = ((safeStart - dayStart) / totalRange) * 100;
                                                    const width = Math.max(((safeEnd - safeStart) / totalRange) * 100, 2.5);
                                                    const durationMinutes = Math.max(0, rawEnd - rawStart);
                                                    const durationHours = Math.floor(durationMinutes / 60);
                                                    const durationMins = durationMinutes % 60;
                                                    const durationLabel = durationMins ? `${durationHours}h ${durationMins}m` : `${durationHours}h`;
                                                    const barAccents = ['from-blue-500/90 to-indigo-500/90','from-violet-500/90 to-fuchsia-500/90','from-emerald-500/90 to-teal-500/90','from-amber-500/90 to-orange-500/90','from-rose-500/90 to-pink-500/90'];

                                                    return (
                                                        <div key={emp.id} className="grid grid-cols-[210px_1fr] gap-0">
                                                            <div className="flex items-center gap-2 pr-3 py-2 min-w-0">
                                                                <div className={`h-9 w-9 shrink-0 rounded-full ${cafe?.color || 'bg-gray-500'} flex items-center justify-center text-white text-xs font-bold shadow-sm ring-2 ring-white dark:ring-[#111]`}>
                                                                    {emp.profilePic ? <img src={emp.profilePic} alt={emp.name} className="h-full w-full rounded-full object-cover" /> : emp.name.charAt(0)}
                                                                </div>
                                                                <div className="min-w-0">
                                                                    <p className="text-xs sm:text-sm font-bold text-gray-900 dark:text-white truncate">{emp.name}</p>
                                                                    <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{emp.role} • {cafe?.name || 'Unassigned'}</p>
                                                                </div>
                                                            </div>
                                                            <div className="relative h-14 rounded-lg bg-gray-50/80 dark:bg-[#0a0a0a] border border-gray-100 dark:border-zinc-800 overflow-hidden">
                                                                {Array.from({ length: 16 }, (_, i) => <div key={i} className="absolute top-0 bottom-0 border-l border-gray-200/70 dark:border-zinc-800/80" style={{ left: `${(i / 15) * 100}%` }} />)}
                                                                <div className={`absolute top-2 bottom-2 rounded-md bg-gradient-to-r ${barAccents[index % barAccents.length]} shadow-md border border-white/20 dark:border-white/10 flex items-center px-2 overflow-hidden transition-all duration-300 hover:brightness-110 hover:scale-[1.01]`} style={{ left: `${left}%`, width: `${width}%` }} title={`${emp.name}: ${startTime} – ${endTime} (${durationLabel})`}>
                                                                    <span className="text-[10px] font-bold text-white whitespace-nowrap drop-shadow-sm">{startTime} – {endTime}</span>
                                                                    <span className="ml-auto text-[9px] font-semibold text-white/85 whitespace-nowrap pl-2">{durationLabel}</span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>

                                            <div className="grid grid-cols-[210px_1fr] mt-4">
                                                <div></div>
                                                <div className="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
                                                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
                                                    <span>{selectedWorking.length} scheduled · Peak simultaneous staffing: {peakCount} at {peakHour}. Use this to compare busy periods across future days.</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })()}

                <div className="sm:hidden space-y-3">
                    {filteredEmployees.length === 0 ? (
                        <div className="bg-white dark:bg-amoled-card rounded-xl p-6 text-center text-gray-500 dark:text-gray-400 italic">No active employees found.</div>
                    ) : (
                        filteredEmployees.map(emp => {
                            const payInfo = calculatePay(emp, selectedMonth, null, logs);
                            const cafe = cafes.find(c => c.id === emp.cafeId);
                            return (
                                <div key={emp.id} className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border p-4">
                                    <div className="flex items-center mb-3">
                                        <div className={`flex-shrink-0 h-12 w-12 rounded-full ${cafe?.color || 'bg-gray-500'} flex items-center justify-center text-white font-bold text-lg`}>
                                            {emp.profilePic ? <img src={emp.profilePic} alt={emp.name} className="h-full w-full rounded-full object-cover" /> : emp.name.charAt(0)}
                                        </div>
                                        <div className="ml-3 flex-grow">
                                            <div className="text-sm font-medium text-gray-900 dark:text-white">{emp.name}</div>
                                            <div className="text-xs text-gray-500 dark:text-gray-400">{emp.role} • {cafe?.name}</div>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2 text-center mb-3 py-2 border-y dark:border-amoled-border">
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase">Base</div>
                                            <div className="text-xs font-semibold dark:text-white">{formatMoney(payInfo.base)}</div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase">Deduct</div>
                                            <div className="text-xs font-semibold text-danger">{payInfo.deductions > 0 ? '-' + formatMoney(payInfo.deductions) : formatMoney(0)}</div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase">Net</div>
                                            <div className="text-xs font-bold dark:text-white">{formatMoney(payInfo.net)}</div>
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <button onClick={() => openScheduleEditor(emp)} className="flex-1 text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 px-3 py-2 rounded-md text-xs font-medium border border-purple-200 dark:border-purple-800">
                                            <i className="fas fa-calendar-alt mr-1"></i>Schedule
                                        </button>
                                        <button onClick={() => openEmployeeDetail(emp.id, selectedMonth)} className="flex-1 text-primary dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 rounded-md text-xs font-medium border border-blue-200 dark:border-blue-800">
                                            <i className="fas fa-user mr-1"></i>Manage
                                        </button>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <div className="relative overflow-hidden rounded-3xl border border-white/35 bg-white/55 p-5 shadow-xl backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.035]">
                        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-primary/10 blur-3xl"></div>
                        <div className="relative flex items-center justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.16em] text-gray-500 dark:text-gray-400">Working today</p><p className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{workingToday.length}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Scheduled team members</p></div><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-2xl text-primary"><i className="fas fa-user-clock"></i></div></div>
                    </div>
                    <div className="relative overflow-hidden rounded-3xl border border-white/35 bg-white/55 p-5 shadow-xl backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.035]">
                        <div className="pointer-events-none absolute -left-10 -bottom-10 h-32 w-32 rounded-full bg-purple-500/10 blur-3xl"></div>
                        <div className="relative flex items-center justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.16em] text-gray-500 dark:text-gray-400">Average net pay</p><p className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{formatMoney(activeEmployees ? grandTotalPay / activeEmployees : 0)}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">For the selected month</p></div><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-500/10 text-2xl text-purple-500"><i className="fas fa-chart-line"></i></div></div>
                    </div>
                </div>

          <div className="hidden sm:block bg-white dark:bg-[#0c0c0c] shadow-lg shadow-black/5 rounded-xl border border-gray-200 dark:border-zinc-800/60">
                    <div className="overflow-x-auto">
                        <table className="min-w-full">
                            <thead className="bg-gray-50 dark:bg-[#111]/50 border-b border-gray-200 dark:border-zinc-800/60">
                                <tr>
                                    <th className="px-6 py-4 text-left text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-wider">Employee</th>
                                    <th className="px-6 py-4 text-left text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-wider">Base Pay</th>
                                    <th className="px-6 py-4 text-left text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-wider">Deductions</th>
                                    <th className="px-6 py-4 text-left text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-wider">Net Pay</th>
                                    <th className="px-6 py-4 text-right text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-wider">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-zinc-800/40">
                                {employeeRows.length > 0 ? employeeRows : <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500 dark:text-gray-400 italic">No active employees found for this location.</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        );
    };

    const renderEmployees = () => {
        const allActiveEmployees = employees.filter(emp => emp.status === 'active');
        const availableEmployeeRoles = [...new Set(allActiveEmployees.map(emp => String(emp.role || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b));
        const filteredEmps = getFilteredEmployees(allActiveEmployees)
            .filter(emp => (emp.name.toLowerCase().includes(searchTerm.toLowerCase()) || String(emp.role || '').toLowerCase().includes(searchTerm.toLowerCase()))
                && (employeeRoleFilter === 'all' || String(emp.role || '') === employeeRoleFilter))
            .sort((a,b) => {
                if (employeeSort === 'salary') return Number(b.baseSalary || 0) - Number(a.baseSalary || 0);
                if (employeeSort === 'role') return String(a.role || '').localeCompare(String(b.role || ''));
                return String(a.name || '').localeCompare(String(b.name || ''));
            });

        return (
            <div className="space-y-5 sm:space-y-7">
                <div className="relative overflow-hidden rounded-[28px] border border-white/35 dark:border-white/10 bg-white/55 dark:bg-white/[0.035] px-5 py-5 sm:px-7 sm:py-6 shadow-xl shadow-black/[0.03] backdrop-blur-2xl">
                    <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-primary/20 blur-3xl"></div>
                    <div className="pointer-events-none absolute -bottom-24 left-1/4 h-48 w-48 rounded-full bg-purple-500/10 blur-3xl"></div>
                    <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
                                <i className="fas fa-users"></i> Team Directory
                            </div>
                            <h1 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Employee Management</h1>
                            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                {selectedCafe === 'all' ? 'Browse and manage your whole team across all locations.' : cafes.find(c => c.id === selectedCafe)?.name}
                            </p>
                        </div>
                        <button type="button" onClick={() => { setHireRole(''); setHireSalary(''); setIsAddEmpOpen(true); }} className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-2xl border border-white/25 bg-gradient-to-br from-blue-500 to-primary px-5 py-3 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(37,99,235,.28),inset_0_1px_0_rgba(255,255,255,.35)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_38px_rgba(37,99,235,.36)]">
                            <i className="fas fa-plus"></i> Hire New
                        </button>
                    </div>
                </div>

                <div className="relative overflow-hidden rounded-[24px] border border-white/35 dark:border-white/10 bg-white/50 dark:bg-white/[0.03] p-3 sm:p-4 shadow-lg shadow-black/[0.025] backdrop-blur-xl">
                    <div className="pointer-events-none absolute -left-12 top-0 h-24 w-24 rounded-full bg-primary/10 blur-2xl"></div>
                    <div className="relative"><CafeSelector /></div>
                </div>

                <div className="relative overflow-hidden rounded-[22px] border border-white/35 dark:border-white/10 bg-white/50 dark:bg-white/[0.03] p-3 sm:p-4 shadow-lg shadow-black/[0.025] backdrop-blur-xl">
                    <div className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-blue-500/10 blur-2xl"></div>
                    <div className="relative">
                        <i className="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-primary"></i>
                        <input type="text" placeholder="Search employees by name or role..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full rounded-xl border border-gray-200/80 bg-white/60 py-3 pl-11 pr-4 text-sm text-gray-900 outline-none transition focus:border-primary/50 focus:ring-4 focus:ring-primary/10 dark:border-white/10 dark:bg-black/20 dark:text-white" />
                    </div>
                </div>

                <div className="flex flex-col gap-3 rounded-[22px] border border-white/35 dark:border-white/10 bg-white/45 dark:bg-white/[0.025] p-3 shadow-lg backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-xl border border-primary/15 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">{filteredEmps.length} employees</span>
                        <select value={employeeRoleFilter} onChange={e => setEmployeeRoleFilter(e.target.value)} className="rounded-xl border border-white/40 bg-white/55 px-3 py-2 text-xs font-medium outline-none dark:border-white/10 dark:bg-black/20 dark:text-white">
                            <option value="all">All roles</option>
                            {availableEmployeeRoles.map(role => <option key={role} value={role}>{role}</option>)}
                        </select>
                        <select value={employeeSort} onChange={e => setEmployeeSort(e.target.value)} className="rounded-xl border border-white/40 bg-white/55 px-3 py-2 text-xs font-medium outline-none dark:border-white/10 dark:bg-black/20 dark:text-white">
                            <option value="name">Sort: Name</option><option value="role">Sort: Role</option><option value="salary">Sort: Salary</option>
                        </select>
                    </div>
                    <div className="inline-flex self-start rounded-xl border border-white/35 bg-white/45 p-1 dark:border-white/10 dark:bg-black/20">
                        <button type="button" onClick={() => setEmployeeViewMode('grid')} className={`h-8 w-9 rounded-lg text-xs transition ${employeeViewMode === 'grid' ? 'bg-primary text-white shadow-lg' : 'text-gray-500 dark:text-gray-400'}`}><i className="fas fa-th-large"></i></button>
                        <button type="button" onClick={() => setEmployeeViewMode('list')} className={`h-8 w-9 rounded-lg text-xs transition ${employeeViewMode === 'list' ? 'bg-primary text-white shadow-lg' : 'text-gray-500 dark:text-gray-400'}`}><i className="fas fa-list"></i></button>
                    </div>
                </div>

                <div className={`${employeeViewMode === 'grid' ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'grid grid-cols-1'} gap-5 sm:gap-6`}>
                    {filteredEmps.length === 0 ? (
                        <div className="col-span-full rounded-3xl border border-dashed border-gray-300 dark:border-white/10 bg-white/50 dark:bg-white/[0.025] p-10 text-center text-gray-500 backdrop-blur-xl dark:text-gray-400 italic">No employees found.</div>
                    ) : filteredEmps.map(emp => {
                        const cafe = cafes.find(c => c.id === emp.cafeId);
                        return (
                            <div key={emp.id} className="group relative overflow-hidden rounded-[28px] border border-white/35 dark:border-white/10 bg-white/60 dark:bg-white/[0.035] shadow-lg shadow-black/[0.025] backdrop-blur-2xl transition duration-300 hover:-translate-y-1 hover:border-primary/25 hover:shadow-2xl">
                                <div className="pointer-events-none absolute -right-14 -top-16 h-40 w-40 rounded-full bg-primary/10 opacity-0 blur-3xl transition group-hover:opacity-100"></div>
                                <div className="relative p-5 sm:p-6 flex-grow text-center">
                                    <div className="relative flex items-start justify-center mb-4 sm:mb-5">
                                        <div className={`h-24 w-24 sm:h-28 sm:w-28 rounded-full ${cafe?.color || 'bg-gray-500'} text-white flex items-center justify-center text-4xl sm:text-5xl font-bold shadow-xl ring-4 ring-white/70 dark:ring-white/10 overflow-hidden`}>
                                            {emp.profilePic ? <img src={emp.profilePic} alt={emp.name} className="h-full w-full rounded-full object-cover" /> : emp.name.charAt(0)}
                                        </div>
                                        <button type="button" onClick={(e) => { e.stopPropagation(); openScheduleEditor(emp); }} className="absolute ml-40 mt-1 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-purple-400/20 bg-purple-500/10 text-purple-600 shadow-sm backdrop-blur-xl transition hover:scale-105 hover:bg-purple-500/20 dark:text-purple-400" title="View/Edit Schedule">
                                            <i className="fas fa-calendar-alt"></i>
                                        </button>
                                    </div>
                                    <h3 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white mb-1">{emp.name}</h3>
                                    <p className="inline-flex rounded-full border border-white/40 bg-white/45 px-3 py-1 text-xs sm:text-sm text-gray-600 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.045] dark:text-gray-300">{emp.role || 'No role assigned'}</p>
                                    <p className="mt-2 text-xs font-medium text-primary">{cafe?.name}</p>

                                    <div className="my-5 flex flex-col items-center rounded-2xl border border-white/35 bg-white/35 px-3 py-4 backdrop-blur-xl dark:border-white/[0.08] dark:bg-black/15">
                                        <p className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Weekly Schedule</p>
                                        <ScheduleViewer schedule={emp.schedule} compact={true} />
                                    </div>

                                    <div className="flex items-center justify-between rounded-2xl border border-white/35 bg-white/35 px-4 py-3 text-xs sm:text-sm backdrop-blur-xl dark:border-white/[0.08] dark:bg-black/15">
                                        <span className="text-gray-500 dark:text-gray-400">Base Pay</span>
                                        <span className="font-bold text-gray-900 dark:text-white">{formatMoney(emp.baseSalary)}</span>
                                    </div>
                                </div>
                                <div className="relative flex justify-between gap-2 border-t border-white/30 bg-white/30 px-4 sm:px-5 py-3 backdrop-blur-xl dark:border-white/[0.08] dark:bg-black/15">
                                    <button type="button" onClick={(e) => { e.stopPropagation(); openScheduleEditor(emp); }} className="flex-1 rounded-xl py-2 text-xs sm:text-sm font-semibold text-purple-600 transition hover:bg-purple-500/10 dark:text-purple-400">
                                        <i className="fas fa-calendar-alt mr-1.5"></i> Schedule
                                    </button>
                                    <button type="button" onClick={(e) => { e.stopPropagation(); openEmployeeDetail(emp.id, selectedMonth); }} className="flex-1 rounded-xl py-2 text-xs sm:text-sm font-semibold text-primary transition hover:bg-primary/10">
                                        Manage Profile <i className="fas fa-chevron-right ml-1 text-[10px]"></i>
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    const renderEmployeeDetail = () => {
        const emp = employees.find(e => e.id === selectedEmployeeId);
        
        if (!emp) {
            return (
                <div className="text-center py-12 px-4">
                    <p className="text-gray-500 dark:text-gray-400 mb-4">Employee not found. Please go back and try again.</p>
                    <button 
                        onClick={() => setCurrentView('dashboard')}
                        className="px-4 py-2 bg-primary text-white rounded-md text-sm"
                    >
                        Go to Dashboard
                    </button>
                </div>
            );
        }

        const payInfo = calculatePay(emp, detailMonth, null, logs);
        const cafe = cafes.find(c => c.id === emp.cafeId);
        
        const typeLabels = LOG_CATEGORIES;
        const getTypeColor = (type) => {
            if (type.includes('bonus')) return 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-400';
            if (type.includes('advance')) return 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400';
            return 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-400';
        };

        const toggleAttendance = async (day) => {
            const dateStr = `${detailMonth}-${String(day).padStart(2, '0')}`;
            let currentAttendance = emp.attendance && emp.attendance[detailMonth] ? [...emp.attendance[detailMonth]] : [];
            
            if (currentAttendance.includes(dateStr)) {
                currentAttendance = currentAttendance.filter(d => d !== dateStr);
            } else {
                currentAttendance.push(dateStr);
            }
            
            try {
                await updateDoc(doc(db, 'employees', emp.id), { [`attendance.${detailMonth}`]: currentAttendance });
                setEmployees(employees.map(e => e.id === emp.id ? { ...e, attendance: { ...(e.attendance || {}), [detailMonth]: currentAttendance } } : e));
            } catch (err) { console.error(err); }
        };

        const renderCalendarDays = () => {
            if (!detailMonth) return null;
            const [year, month] = detailMonth.split('-');
            const daysInMonth = getDaysInMonth(year, month);
            const firstDay = new Date(year, month - 1, 1).getDay();

            const logsByDay = {};
            payInfo.breakdown.forEach(log => {
                if (!log.date) return;
                const day = parseInt(log.date.split('-')[2], 10);
                if (!logsByDay[day]) logsByDay[day] = [];
                logsByDay[day].push(log);
            });

            const getOvertimeHours = (log) => {
                if (log.type !== 'bonus_overtime') return 0;
                if (Number.isFinite(Number(log.overtimeHours))) return Number(log.overtimeHours);
                const text = String(log.reason || '');
                const quickMatch = text.match(/Quick overtime\s*[•·]\s*([\d.]+)\s*hour/i);
                const loggedMatch = text.match(/^\s*([\d.]+)\s*Hours\s+logged/i);
                const match = quickMatch || loggedMatch;
                return match ? Number(match[1]) : 0;
            };

            const cells = [];
            for (let i = 0; i < firstDay; i++) {
                cells.push(<div key={`empty-${i}`} className="aspect-square rounded-md bg-transparent"></div>);
            }

            for (let i = 1; i <= daysInMonth; i++) {
                const dateStr = `${year}-${month}-${String(i).padStart(2, '0')}`;
                const dayLogs = logsByDay[i] || [];
                const overtimeHours = dayLogs.reduce((sum, log) => sum + getOvertimeHours(log), 0);
                const hasOvertime = overtimeHours > 0;
                const isWorked = emp.attendance && emp.attendance[detailMonth]
                    ? emp.attendance[detailMonth].includes(dateStr)
                    : false;

                const boxClass = `aspect-square flex flex-col items-center justify-center rounded-md border relative overflow-hidden group cursor-pointer transition-all select-none ${
                    isWorked
                        ? 'border-green-400 bg-green-50 dark:bg-green-900/20 dark:border-green-800/50 shadow-sm'
                        : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-amoled-surface hover:border-gray-400'
                }`;

                const dots = dayLogs.length > 0 ? (
                    <div className="absolute bottom-0.5 flex flex-wrap justify-center gap-0.5 px-1 w-full z-10">
                        {dayLogs.filter(log => log.type !== 'bonus_overtime').map((log, idx) => (
                            <span
                                key={`${log.id || idx}-${idx}`}
                                className={`w-1.5 h-1.5 rounded-full ${
                                    log.type.includes('bonus')
                                        ? 'bg-green-500'
                                        : log.type.includes('advance')
                                            ? 'bg-blue-500'
                                            : 'bg-red-500'
                                }`}
                            ></span>
                        ))}
                    </div>
                ) : null;

                cells.push(
                    <div
                        key={dateStr}
                        className={boxClass}
                        onClick={() => toggleAttendance(i)}
                        title={`${isWorked ? 'Worked' : 'Off'}${hasOvertime ? ` • ⚡ +${overtimeHours}h overtime` : ''} (Click to ${isWorked ? 'mark Off' : 'mark Worked'})`}
                    >
                        <span className={`font-bold z-10 text-[10px] sm:text-xs ${isWorked ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
                            {i}
                        </span>
                        {hasOvertime && (
                            <span className="absolute top-0.5 right-0.5 z-20 text-[8px] sm:text-[9px] leading-none font-bold px-1 py-0.5 rounded bg-yellow-400/15 text-yellow-600 dark:text-yellow-400 border border-yellow-400/20">
                                ⚡{overtimeHours}h
                            </span>
                        )}
                        {dots}
                    </div>
                );
            }
            return cells;
        };

  const handleLogSubmit = async (e) => {
            e.preventDefault();
            if (!logForm.date || !lockSubmission('add-log')) return;
            setIsAddingLog(true);
            
            try {
                let finalAmount = logForm.amount === '' ? null : parseFloat(logForm.amount);
                let finalReason = logForm.reason;

                // Smart Overtime Logic: Multiply hours by hourly rate automatically!
                if (logForm.type === 'bonus_overtime' && finalAmount) {
                    const hourlyRate = emp.hourlyRate || Math.round(payInfo.shiftRate / 9);
                    finalReason = `${finalAmount} Hours logged. ${finalReason}`;
                    finalAmount = finalAmount * hourlyRate;
                }

                const newLog = {
                    employeeId: emp.id,
                    month: detailMonth,
                    date: logForm.date,
                    type: logForm.type,
                    reason: finalReason,
                    amount: finalAmount
                };
                
                const docRef = await addDoc(collection(db, 'logs'), newLog);
                
                const updatedLogs = { ...logs };
                if (!updatedLogs[emp.id]) updatedLogs[emp.id] = {};
                if (!updatedLogs[emp.id][detailMonth]) updatedLogs[emp.id][detailMonth] = [];
                updatedLogs[emp.id][detailMonth].push({ id: docRef.id, ...newLog });
                setLogs(updatedLogs);
                setLogForm({...logForm, reason: '', amount: ''});
            } catch (error) {
                console.error('Error adding log:', error);
                setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to add log entry.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
            } finally {
                unlockSubmission('add-log');
                setIsAddingLog(false);
            }
        };
        const openCustomModal = ({ title, description = '', fields = [], values = {}, confirmLabel = 'Save', danger = false, onSave }) => {
            setCustomModal({ isOpen: true, title, description, fields, values, confirmLabel, danger, onSave });
        };

        const editLog = (logItem) => openCustomModal({
            title: 'Edit Financial Entry',
            description: 'Update the amount or details for this ledger entry.',
            fields: [
                { name: 'amount', label: 'Amount (KZT)', type: 'number', step: '0.01', icon: 'fa-coins' },
                { name: 'reason', label: 'Reason / Details', type: 'text', icon: 'fa-align-left' }
            ],
            values: { amount: String(logItem.amount ?? ''), reason: logItem.reason || '' },
            confirmLabel: 'Save Changes',
            onSave: async (values) => {
                try {
                    const amount = parseFloat(values.amount);
                    if (Number.isNaN(amount)) { setAlertConfig({ isOpen: true, title: 'Invalid Amount', message: 'Please enter a valid amount.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) }); return; }
                    await updateDoc(doc(db, 'logs', logItem.id), { amount, reason: values.reason });
                    const updatedLogs = { ...logs };
                    const logIndex = updatedLogs[emp.id]?.[detailMonth]?.findIndex(l => l.id === logItem.id);
                    if (logIndex > -1) { updatedLogs[emp.id][detailMonth][logIndex].amount = amount; updatedLogs[emp.id][detailMonth][logIndex].reason = values.reason; setLogs(updatedLogs); }
                    closeCustomModal();
                } catch (error) { console.error('Error editing log:', error); setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to edit entry.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) }); }
            }
        });

        const deleteLog = (logId) => openCustomModal({
            title: 'Delete Financial Entry?',
            description: 'This will permanently remove this ledger entry. This action cannot be undone.',
            confirmLabel: 'Delete Entry', danger: true,
            onSave: async () => {
                try {
                    await deleteDoc(doc(db, 'logs', logId));
                    const updatedLogs = { ...logs };
                    if (updatedLogs[emp.id] && updatedLogs[emp.id][detailMonth]) { updatedLogs[emp.id][detailMonth] = updatedLogs[emp.id][detailMonth].filter(log => log.id !== logId); setLogs(updatedLogs); }
                    closeCustomModal();
                } catch (error) { console.error('Error deleting log:', error); setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to delete log entry.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) }); }
            }
        });

        // Quick Overtime — adds a ready-made overtime entry without touching the normal ledger UI
        const defaultOvertimeHours = Number(emp.defaultOvertimeHours ?? 5) || 5;
        const overtimeHourlyRate = Number(emp.hourlyRate ?? Math.round(payInfo.shiftRate / 9)) || 0;

        const getQuickOvertimeDate = () => {
            if (quickOvertime.date) return quickOvertime.date;
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            if (detailMonth === currentMonth) return `${currentMonth}-${String(now.getDate()).padStart(2, '0')}`;
            return detailMonth ? `${detailMonth}-01` : '';
        };

        const getQuickOvertimeHours = () => {
            const value = Number(quickOvertime.hours);
            return quickOvertime.hours === '' || Number.isNaN(value) ? defaultOvertimeHours : value;
        };

        // Optional per-entry rate override. Leave it empty to use the employee's normal overtime rate.
        const getQuickOvertimeRate = () => {
            const value = Number(quickOvertime.customRate);
            return quickOvertime.customRate === '' || Number.isNaN(value) ? overtimeHourlyRate : value;
        };

        const handleQuickOvertime = async () => {
            if (!lockSubmission('quick-overtime')) return;
            setIsAddingQuickOvertime(true);
            const date = getQuickOvertimeDate();
            const hours = getQuickOvertimeHours();
            if (!date || !detailMonth || date.slice(0, 7) !== detailMonth) {
                setAlertConfig({ isOpen: true, title: 'Choose a Date', message: 'Please choose a date inside the selected payroll month.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) });
                unlockSubmission('quick-overtime');
                setIsAddingQuickOvertime(false);
                return;
            }
            if (!Number.isFinite(hours) || hours <= 0) {
                setAlertConfig({ isOpen: true, title: 'Invalid Hours', message: 'Extra hours must be greater than zero.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) });
                unlockSubmission('quick-overtime');
                setIsAddingQuickOvertime(false);
                return;
            }
            const rate = getQuickOvertimeRate();
            if (!Number.isFinite(rate) || rate < 0) {
                setAlertConfig({ isOpen: true, title: 'Invalid Rate', message: 'Please enter a valid overtime rate or leave the field empty to use the default rate.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) });
                unlockSubmission('quick-overtime');
                setIsAddingQuickOvertime(false);
                return;
            }
            try {
                const amount = hours * rate;
                const newLog = {
                    employeeId: emp.id, month: detailMonth, date, type: 'bonus_overtime',
                    reason: `Quick overtime • ${hours} hour${hours === 1 ? '' : 's'}${quickOvertime.customRate !== '' ? ` • custom rate ${formatMoney(rate)}/hr` : ''}`,
                    amount, overtimeHours: hours, hourlyRateUsed: rate
                };
                const docRef = await addDoc(collection(db, 'logs'), newLog);
                const updatedLogs = { ...logs };
                if (!updatedLogs[emp.id]) updatedLogs[emp.id] = {};
                if (!updatedLogs[emp.id][detailMonth]) updatedLogs[emp.id][detailMonth] = [];
                updatedLogs[emp.id][detailMonth] = [...updatedLogs[emp.id][detailMonth], { id: docRef.id, ...newLog }];
                setLogs(updatedLogs);
                setQuickOvertime({ date: '', hours: '', customRate: '' });
            } catch (error) {
                console.error('Error adding quick overtime:', error);
                setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to add overtime.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) });
            } finally {
                unlockSubmission('quick-overtime');
                setIsAddingQuickOvertime(false);
            }
        };

        const saveRemarks = async (val) => {
            try {
                await updateDoc(doc(db, 'employees', emp.id), { remarks: val });
                const updatedEmps = employees.map(e => e.id === emp.id ? {...e, remarks: val} : e);
                setEmployees(updatedEmps);
            } catch (error) {
                console.error('Error updating remarks:', error);
                setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to update remarks.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
            }
        };

        return (
            <div className="space-y-4 sm:space-y-6 fade-in">
                <div className="flex items-center gap-3 sm:gap-4 mb-2 sm:mb-4">
                    <button onClick={() => setCurrentView('employees')} className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors p-1">
                        <i className="fas fa-arrow-left text-lg sm:text-xl"></i>
                    </button>
                    {emp.profilePic ? (
                        <img src={emp.profilePic} alt={emp.name} className="w-10 h-10 sm:w-12 sm:h-12 rounded-full object-cover shadow-sm ring-2 ring-primary/20" />
                    ) : (
                        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full ${cafe?.color || 'bg-gray-500'} flex items-center justify-center text-white font-bold text-lg shadow-sm ring-2 ring-white/10`}>
                            {emp.name.charAt(0)}
                        </div>
                    )}
                    <div className="min-w-0">
                        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white truncate">{emp.name}</h1>
                        {cafe && <p className="text-xs sm:text-sm text-primary truncate">{cafe.name} {cafe.location && `• ${cafe.location}`}</p>}
                    </div>
                </div>
                
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
                    <div className="space-y-4 sm:space-y-6 lg:col-span-1">
                        <div className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border overflow-hidden">
                            <div className="bg-gray-50 dark:bg-[#0a0a0a] px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-200 dark:border-amoled-border flex justify-between items-center">
                                <h3 className="font-semibold text-sm sm:text-base text-gray-800 dark:text-gray-200">Profile Details</h3>
                                <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">Active</span>
                            </div>
                         <div className="p-4 sm:p-6 space-y-3 sm:space-y-4">
                                <div>
                                    <p className="text-xs sm:text-sm text-gray-500">Role/Position</p>
                                    <p className="font-medium text-sm sm:text-base dark:text-white cursor-pointer hover:text-blue-500 transition-colors" title="Click to edit role" onClick={() => openCustomModal({
                                        title: 'Update Role / Position',
                                        description: 'Enter the employee’s current role or position.',
                                        fields: [{ name: 'role', label: 'Role / Position', type: 'role-picker', icon: 'fa-user-tag' }],
                                        values: { role: emp.role || '' },
                                        confirmLabel: 'Update Role',
                                        onSave: async (values) => {
                                            const role = values.role.trim();
                                            if (!role) return;
                                            const roleTemplate = getRoleTemplate(role);
                                            const updates = roleTemplate ? { role, baseSalary: Number(roleTemplate.salary) } : { role };
                                            try {
                                                await updateDoc(doc(db, 'employees', emp.id), updates);
                                                setEmployees(employees.map(e => e.id === emp.id ? { ...e, ...updates } : e));
                                                closeCustomModal();
                                            } catch (error) {
                                                console.error('Error updating role:', error);
                                                setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to update role.', onConfirm: () => setAlertConfig(prev => ({ ...prev, isOpen: false })) });
                                            }
                                        }
                                    })}>{emp.role} <i className="fas fa-pencil-alt text-[10px] ml-1 opacity-50"></i></p>
                                </div>
                                <div><p className="text-xs sm:text-sm text-gray-500">Location</p><p className="font-medium text-sm sm:text-base dark:text-white">{cafe?.name || 'N/A'}</p></div>
                                <div>
                                    <p className="text-xs sm:text-sm text-gray-500">Global Base Salary (15 Shifts)</p>
                                    <p className="font-medium text-sm sm:text-base dark:text-white cursor-pointer hover:text-blue-500" title="Click to edit global salary" onClick={() => openCustomModal({ title: 'Update Global Base Salary', description: "Set the employee's monthly salary for the 15-shift pay cycle.", fields: [{ name: 'baseSalary', label: 'Monthly Salary (KZT)', type: 'number', step: '0.01', icon: 'fa-wallet' }], values: { baseSalary: String(emp.baseSalary ?? '') }, confirmLabel: 'Update Salary', onSave: async (values) => { const baseSalary = parseFloat(values.baseSalary); if (Number.isNaN(baseSalary) || baseSalary < 0) return; await updateDoc(doc(db, 'employees', emp.id), { baseSalary }); setEmployees(employees.map(e => e.id === emp.id ? { ...e, baseSalary } : e)); closeCustomModal(); } })}>{formatMoney(emp.baseSalary)} <i className="fas fa-pencil-alt text-[10px] ml-1 opacity-50"></i></p>
                                </div>
  <div><p className="text-xs sm:text-sm text-gray-500">Shift Rate</p><p className="font-medium text-sm sm:text-base dark:text-white">{formatMoney(payInfo.shiftRate)} / shift</p></div>
                                <div>
                                    <p className="text-xs sm:text-sm text-gray-500">Overtime Hourly Rate</p>
                                    <p className="font-medium text-sm sm:text-base dark:text-white cursor-pointer hover:text-blue-500" title="Click to edit hourly rate" onClick={() => { const defaultRate = Math.round(payInfo.shiftRate / 9); openCustomModal({ title: 'Update Overtime Hourly Rate', description: 'Set the amount paid for each overtime hour.', fields: [{ name: 'hourlyRate', label: 'Hourly Rate (KZT)', type: 'number', step: '0.01', icon: 'fa-clock' }], values: { hourlyRate: String(emp.hourlyRate ?? defaultRate) }, confirmLabel: 'Update Rate', onSave: async (values) => { const hourlyRate = parseFloat(values.hourlyRate); if (Number.isNaN(hourlyRate) || hourlyRate < 0) return; await updateDoc(doc(db, 'employees', emp.id), { hourlyRate }); setEmployees(employees.map(e => e.id === emp.id ? { ...e, hourlyRate } : e)); closeCustomModal(); } }); }}>{formatMoney(emp.hourlyRate || Math.round(payInfo.shiftRate / 9))} / hr <i className="fas fa-pencil-alt text-[10px] ml-1 opacity-50"></i></p>
                                </div>
                                <div>
                                    <p className="text-xs sm:text-sm text-gray-500">Typical Extra Hours <span className="ml-1">⚡</span></p>
                                    <p className="font-medium text-sm sm:text-base dark:text-white cursor-pointer hover:text-blue-500 transition-colors" title="Click to edit typical extra hours" onClick={() => openCustomModal({
                                        title: 'Update Typical Extra Hours',
                                        description: 'Set the number of overtime hours this employee usually works. You can still change it each time before adding overtime.',
                                        fields: [{ name: 'defaultOvertimeHours', label: 'Typical Extra Hours', type: 'number', step: '0.5', icon: 'fa-bolt' }],
                                        values: { defaultOvertimeHours: String(emp.defaultOvertimeHours ?? 5) },
                                        confirmLabel: 'Update Hours',
                                        onSave: async (values) => {
                                            const defaultOvertimeHours = parseFloat(values.defaultOvertimeHours);
                                            if (Number.isNaN(defaultOvertimeHours) || defaultOvertimeHours <= 0) return;
                                            await updateDoc(doc(db, 'employees', emp.id), { defaultOvertimeHours });
                                            setEmployees(employees.map(e => e.id === emp.id ? { ...e, defaultOvertimeHours } : e));
                                            closeCustomModal();
                                        }
                                    })}><span className="mr-1">⚡</span>{emp.defaultOvertimeHours ?? 5} hrs <i className="fas fa-pencil-alt text-[10px] ml-1 opacity-50"></i></p>
                                </div>
                                <div>
                                    <p className="text-xs sm:text-sm text-gray-500 mb-1">Update Profile Photo</p>
                                    <input type="file" accept="image/*" onChange={async (e) => {
                                        const file = e.target.files[0];
                                        if (!file) return;
                                        try {
                                            const compressedBase64 = await compressImage(file);
                                            await updateDoc(doc(db, 'employees', emp.id), { profilePic: compressedBase64 });
                                            setEmployees(employees.map(x => x.id === emp.id ? {...x, profilePic: compressedBase64} : x));
                                        } catch (err) { 
                                            console.error(err);
                                            setAlertConfig({ isOpen: true, title: 'Upload Failed', message: 'Could not process the image.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
                                        }
                                    }} className="w-full border rounded-md py-1.5 px-2 text-xs dark:bg-[#111] dark:border-zinc-700 dark:text-white focus:border-primary outline-none transition-colors file:mr-3 file:py-1 file:px-2 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer" />
                                </div>
                                <div className="pt-3 sm:pt-4 border-t dark:border-amoled-border space-y-2">
                                    <button 
                                        onClick={() => openScheduleEditor(emp)}
                                        className="w-full inline-flex justify-center items-center px-3 sm:px-4 py-2 border border-purple-300 shadow-sm text-xs sm:text-sm font-medium rounded-md text-purple-700 bg-white dark:bg-amoled-card hover:bg-purple-50 dark:border-purple-900/50 dark:text-purple-400 dark:hover:bg-purple-900/10 transition-colors"
                                    >
                                        <i className="fas fa-calendar-alt mr-2"></i> Edit Schedule
                                    </button>
                                    <button onClick={() => {
                                        setAlertConfig({
                                            isOpen: true, title: "Terminate Employee", message: `Are you sure you want to fire ${emp.name}?`,
                                            onConfirm: async () => {
                                                try {
                                                    await updateDoc(doc(db, 'employees', emp.id), { status: 'fired' });
                                                    setEmployees(employees.map(e => e.id === emp.id ? { ...e, status: 'fired' } : e));
                                                    setCurrentView('employees');
                                                    setAlertConfig(prev => ({...prev, isOpen: false}));
                                                } catch (error) {
                                                    console.error('Error firing employee:', error);
                                                    setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to terminate employee.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
                                                }
                                            }
                                        });
                                    }} className="w-full inline-flex justify-center items-center px-3 sm:px-4 py-2 border border-red-300 shadow-sm text-xs sm:text-sm font-medium rounded-md text-red-700 bg-white dark:bg-amoled-card hover:bg-red-50 dark:border-red-900/50 dark:text-red-500 dark:hover:bg-red-900/10 transition-colors">
                                        <i className="fas fa-user-slash mr-2"></i> Terminate Employee
                                    </button>
                                </div>
                            </div>
                        </div>
                        
                        <div className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border overflow-hidden">
                            <div className="bg-purple-50 dark:bg-purple-900/20 px-4 sm:px-6 py-3 sm:py-4 border-b border-purple-100 dark:border-purple-800">
                                <h3 className="font-semibold text-sm sm:text-base text-purple-900 dark:text-purple-400">Weekly Schedule</h3>
                            </div>
                            <div className="p-4 sm:p-6">
                                <ScheduleViewer schedule={emp.schedule} compact={false} />
                            </div>
                        </div>
                        
                        <div className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border flex flex-col">
                            <div className="bg-gray-50 dark:bg-[#0a0a0a] px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-200 dark:border-amoled-border">
                                <h3 className="font-semibold text-sm sm:text-base text-gray-800 dark:text-gray-200">General Remarks</h3>
                            </div>
                            <div className="p-3 sm:p-4">
                                <textarea value={emp.remarks || ''} onChange={(e) => saveRemarks(e.target.value)} className="w-full p-2 sm:p-3 border border-gray-300 dark:border-zinc-700 dark:bg-amoled-surface dark:text-white rounded-md focus:ring-primary focus:border-primary resize-none text-sm min-h-[120px]" placeholder="Add notes..."></textarea>
                            </div>
                        </div>
                    </div>
                    
                    <div className="space-y-4 sm:space-y-6 lg:col-span-2">
                        <div className="bg-white dark:bg-amoled-card p-3 sm:p-4 rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                            <h3 className="font-semibold text-sm sm:text-base text-gray-800 dark:text-gray-200">Performance & Pay for:</h3>
                            <div className="w-full sm:w-auto z-40"><ModernDropdown value={detailMonth} onChange={setDetailMonth} options={generateMonthOptions()} /></div>
                        </div>
                        
                        <div className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border p-3 sm:p-4">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-9 h-9 rounded-lg bg-yellow-400/10 text-yellow-500 flex items-center justify-center shrink-0 text-lg">⚡</div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h3 className="font-semibold text-sm sm:text-base text-gray-800 dark:text-gray-200">Quick Overtime</h3>
                                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-yellow-400/10 text-yellow-600 dark:text-yellow-400">⚡ Default {defaultOvertimeHours}h</span>
                                        </div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{formatMoney(getQuickOvertimeRate())} / hr • {formatMoney(getQuickOvertimeHours() * getQuickOvertimeRate())} estimated</p>
                                    </div>
                                </div>
                                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                                    <div className="sm:w-40"><ModernDatePicker value={getQuickOvertimeDate()} onChange={(val) => setQuickOvertime(prev => ({ ...prev, date: val }))} /></div>
                                    <div className="flex items-center justify-center rounded-md border border-gray-200 dark:border-zinc-700 overflow-hidden dark:bg-amoled-surface">
                                        <button type="button" onClick={() => setQuickOvertime(prev => { const current = prev.hours === '' ? defaultOvertimeHours : Number(prev.hours); return { ...prev, hours: Math.max(0.5, Number((current - 0.5).toFixed(1))) }; })} className="w-9 h-9 text-gray-500 hover:text-primary hover:bg-primary/5 transition-colors" title="Decrease hours"><i className="fas fa-minus text-xs"></i></button>
                                        <div className="min-w-[68px] text-center"><span className="text-sm font-semibold dark:text-white">{getQuickOvertimeHours()}</span><span className="text-[10px] text-gray-500 ml-1">hrs</span></div>
                                        <button type="button" onClick={() => setQuickOvertime(prev => { const current = prev.hours === '' ? defaultOvertimeHours : Number(prev.hours); return { ...prev, hours: Number((current + 0.5).toFixed(1)) }; })} className="w-9 h-9 text-gray-500 hover:text-primary hover:bg-primary/5 transition-colors" title="Increase hours"><i className="fas fa-plus text-xs"></i></button>
                                    </div>
                                    <div className="relative sm:w-40">
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={quickOvertime.customRate}
                                            onChange={(e) => setQuickOvertime(prev => ({ ...prev, customRate: e.target.value }))}
                                            placeholder={`Rate (auto: ${overtimeHourlyRate})`}
                                            className="w-full h-9 rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-amoled-surface px-3 pr-9 text-xs text-gray-800 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                                            title="Optional custom overtime rate. Leave empty to use the employee's normal rate."
                                        />
                                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 pointer-events-none">KZT/hr</span>
                                    </div>
                                    <button type="button" disabled={isAddingQuickOvertime} onClick={handleQuickOvertime} className="bg-primary hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-xs sm:text-sm font-medium shadow-sm transition-colors whitespace-nowrap">{isAddingQuickOvertime ? <><i className="fas fa-spinner fa-spin mr-1.5"></i>Adding...</> : <><span className="mr-1.5">⚡</span>Add {getQuickOvertimeHours()}h</>}</button>
                                </div>
                            </div>
                        </div>

                        <div className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border relative z-20">
                            <div className="bg-indigo-50 dark:bg-indigo-900/10 px-4 sm:px-6 py-3 sm:py-4 border-b border-indigo-100 flex justify-between items-center rounded-t-xl">
                                <h3 className="font-semibold text-sm sm:text-base text-indigo-900 dark:text-indigo-400">Log Financial Entry</h3>
                                <span className="hidden sm:inline text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-900/30 px-2 py-1 rounded-full shadow-sm"><i className="fas fa-plus-circle mr-1"></i>Bonus, Advance, Deduction</span>
                            </div>
                            <div className="p-4 sm:p-6">
                                <form onSubmit={handleLogSubmit} className="space-y-3 sm:space-y-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                                        <div><label className="block text-xs sm:text-sm font-medium dark:text-gray-300 mb-1">Date</label><ModernDatePicker value={logForm.date} onChange={(val) => setLogForm({...logForm, date: val})} /></div>
                            <div>
                                            <label className="block text-xs sm:text-sm font-medium dark:text-gray-300 mb-1">Category</label>
                                            <select value={logForm.type} onChange={e=>setLogForm({...logForm, type: e.target.value})} className="w-full border rounded-md py-2 px-3 dark:bg-amoled-surface dark:border-zinc-700 dark:text-white text-sm">
                                                {Object.keys(typeLabels).map(k => <option key={k} value={k}>{typeLabels[k]}</option>)}
                                            </select>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-xs sm:text-sm font-medium dark:text-gray-300 mb-1">Details & Amount (KZT)</label>
                                        <div className="flex flex-col sm:flex-row gap-3">
<input type="text" placeholder="Reason or Details..." value={logForm.reason} onChange={e=>setLogForm({...logForm, reason: e.target.value})} className="flex-grow border rounded-md py-2 px-3 dark:bg-amoled-surface dark:border-zinc-700 dark:text-white text-sm" />
                                            <input type="number" required min="0.5" step="0.5" placeholder={logForm.type === 'bonus_overtime' ? "Hours (e.g. 2.5)" : "Amount (KZT)"} value={logForm.amount} onChange={e=>setLogForm({...logForm, amount: e.target.value})} className="w-full sm:w-1/3 border rounded-md py-2 px-3 dark:bg-amoled-surface dark:border-zinc-700 dark:text-white text-sm" />
                                        </div>
                                    </div>
                                    <div className="flex justify-end"><button type="submit" disabled={isAddingLog} className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed text-white py-2 px-4 rounded-md font-medium text-xs sm:text-sm transition-colors">{isAddingLog ? <><i className="fas fa-spinner fa-spin mr-2"></i>Adding...</> : 'Add Entry'}</button></div>
                                </form>
                            </div>
                        </div>

                        <div className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border overflow-hidden">
                            <div className="p-4 sm:p-6 bg-gradient-to-r from-gray-50 to-white dark:from-[#0f0f0f] dark:to-[#111] border-b border-gray-200 dark:border-zinc-800/60">
                                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
                                    <div>
                                        <p className="text-xs sm:text-sm text-gray-500 mb-1">Final Amount Payable</p>
                                        <p className="text-2xl sm:text-4xl font-bold text-success">{formatMoney(payInfo.net)}</p>
                                        <div className="mt-2 text-xs text-gray-500">
                                            Planned Shifts: <span className="text-gray-700 dark:text-gray-300 font-bold">{payInfo.targetShifts}</span> | Actual Worked: <span className="text-primary font-bold">{payInfo.actualShifts}</span>
                                        </div>
                                    </div>
                          <div className="text-left sm:text-right w-full sm:w-auto grid grid-cols-2 sm:block gap-2 text-xs sm:text-sm">
                                        <p className="text-gray-500">
                                            Shift Base Pay: <span className="font-medium dark:text-white cursor-pointer hover:text-blue-500" title="Click to manually override this month's base pay" onClick={async () => {
                                                const manualStr = window.prompt(`Override Base Pay for ${detailMonth}? (Leave blank to revert to automatic calculation)`, payInfo.proratedBase);
                                                if (manualStr !== null) {
                                                    const manualVal = manualStr === '' ? null : parseFloat(manualStr);
                                                    try {
                                                        const newCustomBase = { ...(emp.customBasePay || {}) };
                                                        if (manualVal === null || isNaN(manualVal)) delete newCustomBase[detailMonth];
                                                        else newCustomBase[detailMonth] = manualVal;
                                                        await updateDoc(doc(db, 'employees', emp.id), { customBasePay: newCustomBase });
                                                        setEmployees(employees.map(e => e.id === emp.id ? { ...e, customBasePay: newCustomBase } : e));
                                                    } catch (err) { console.error(err); }
                                                }
                                            }}>{formatMoney(payInfo.proratedBase)} <i className="fas fa-pencil-alt text-[10px] ml-1 opacity-50"></i></span>
                                        </p>
                                        <p className="text-green-600 dark:text-green-400 sm:mt-1">Bonuses: <span className="font-medium">+{formatMoney(payInfo.bonuses)}</span></p>
                                        <p className="text-red-600 dark:text-red-400 sm:mt-1">Deductions: <span className="font-medium">-{formatMoney(payInfo.deductions)}</span></p>
                                        <p className="text-blue-600 dark:text-blue-400 sm:mt-1">Advances: <span className="font-medium">-{formatMoney(payInfo.advances)}</span></p>
                                    </div>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-200 dark:border-amoled-border">
                                <div className="p-4 sm:p-6">
                                    <h4 className="text-xs sm:text-sm font-medium mb-3 sm:mb-4 text-center dark:text-gray-300">Click Days Worked (Green)</h4>
                                    <div className="grid grid-cols-7 gap-0.5 sm:gap-1 text-center text-[10px] sm:text-xs text-gray-500 mb-2 font-medium">
                                        <div>Su</div><div>Mo</div><div>Tu</div><div>We</div><div>Th</div><div>Fr</div><div>Sa</div>
                                    </div>
                                    <div className="grid grid-cols-7 gap-0.5 sm:gap-1 text-[10px] sm:text-sm">
                                        {renderCalendarDays()}
                                    </div>
                                </div>
                                <div className="p-4 sm:p-6 flex flex-col" style={{maxHeight: '400px'}}>
                                    <h4 className="text-xs sm:text-sm font-medium mb-3 sm:mb-4 dark:text-gray-300">Financial Ledger</h4>
                                    <div className="flex-grow overflow-y-auto pr-2">
                                        {payInfo.breakdown.length === 0 ? <p className="text-gray-500 italic text-center py-4">No financial entries recorded.</p> : 
                                            [...payInfo.breakdown].sort((a, b) => new Date(b.date) - new Date(a.date)).map(log => {
                                                const isBonus = log.type.includes('bonus');
                                                const isAdvance = log.type.includes('advance');
                                                
                                                return (
                                           <div key={log.id} className="mb-2 p-2 sm:p-2.5 rounded-lg border border-gray-100 dark:border-amoled-border bg-white dark:bg-amoled-surface flex flex-col gap-2 relative group">
                                                        <div className="flex justify-between items-start">
                                                            <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
                                                                <span className="text-[10px] sm:text-xs font-semibold dark:text-gray-300">{formatDateDisplay(log.date)}</span>
                                                                <span className={`px-1 sm:px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-medium border ${getTypeColor(log.type)}`}>{typeLabels[log.type] || log.type}</span>
                                                            </div>
                                                            <span className={`font-bold text-[10px] sm:text-xs ${isBonus ? 'text-success' : isAdvance ? 'text-blue-500' : 'text-danger'}`}>
                                                                {isBonus ? '+' : '-'}{formatMoney(log.appliedAmount)}
                                                            </span>
                                                        </div>
                                                        <div className="flex justify-between items-end pl-1 sm:pl-12">
                                                            <p className="text-[10px] sm:text-xs text-gray-600 dark:text-gray-400 truncate pr-2">{log.reason || '-'}</p>
                                                            <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                                                                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); editLog(log); }} className="text-gray-400 hover:text-blue-500"><i className="fas fa-pencil-alt text-xs sm:text-sm"></i></button>
                                                                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteLog(log.id); }} className="text-gray-400 hover:text-red-500"><i className="fas fa-trash-alt text-xs sm:text-sm"></i></button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        }
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                </div>
            
        );
    };


    const renderPayday = () => {
        let totalPending = 0; 
        let totalSettled = 0;

        const allRelevantEmployees = employees.filter(emp => {
            if (emp.status === 'active') return true;
            const hasLogs = logs[emp.id] && logs[emp.id][selectedMonth] && logs[emp.id][selectedMonth].length > 0;
            const hasPayment = payments[emp.id] && payments[emp.id][selectedMonth];
            return hasLogs || hasPayment;
        });

        const relevantEmployees = getFilteredEmployees(allRelevantEmployees);

        const rows = relevantEmployees.map(emp => {
            const payInfo = calculatePay(emp, selectedMonth, null, logs);
            const paymentRecord = (payments[emp.id] && payments[emp.id][selectedMonth]) ? payments[emp.id][selectedMonth] : null;
            const isPaid = !!paymentRecord;
            const cafe = cafes.find(c => c.id === emp.cafeId);
            
            if (isPaid) totalSettled += paymentRecord.amount;
            else totalPending += payInfo.net;

            return (
           <tr key={emp.id} className="hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors group">
                    <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap">
                        <div className="flex items-center">
                            <div className={`flex-shrink-0 h-8 w-8 sm:h-10 sm:w-10 rounded-full ${cafe?.color || 'bg-gray-500'} flex items-center justify-center text-white text-xs sm:text-sm font-bold mr-2 sm:mr-3`}>
                                {emp.profilePic ? <img src={emp.profilePic} alt={emp.name} className="h-full w-full rounded-full object-cover" /> : emp.name.charAt(0)}
                            </div>
                            <div className="min-w-0">
                                <div className="font-medium text-xs sm:text-sm text-gray-900 dark:text-white truncate">{emp.name} {emp.status === 'fired' && <span className="text-red-500 text-[10px] sm:text-xs ml-1">(Fired)</span>}</div>
                                <div className="text-[10px] sm:text-xs text-gray-500 truncate">{cafe?.name}</div>
                            </div>
                        </div>
                    </td>
                    <td className="hidden md:table-cell px-6 py-4 whitespace-nowrap text-xs sm:text-sm text-gray-500 dark:text-gray-400">{isPaid ? (paymentRecord.type === 'partial' ? `Up to ${formatDateDisplay(paymentRecord.customEndDate)}` : 'Full Month') : 'Pending'}</td>
                    <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap text-xs sm:text-sm font-bold dark:text-white">{isPaid ? formatMoney(paymentRecord.amount) : formatMoney(payInfo.net)}</td>
                    <td className="hidden sm:table-cell px-6 py-4 whitespace-nowrap">
                        {isPaid ? <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"><i className="fas fa-check mr-1"></i>Paid</span> : <span className="px-2 py-1 text-xs rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">Pending</span>}
                    </td>
                    <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap text-right">
                        {isPaid ? (
                            <div className="flex flex-col items-end gap-1">
                                <span className="hidden sm:inline text-xs text-gray-400 italic">Settled on {formatDateDisplay(paymentRecord.datePaid)}</span>
                                <button onClick={() => downloadPayslip(emp.id, selectedMonth)} className="text-xs bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700/50 px-2 sm:px-3 py-1.5 rounded-md border inline-flex items-center hover:bg-indigo-100 transition-colors"><i className="fas fa-file-pdf text-red-500 mr-1"></i><span className="hidden sm:inline">PDF</span></button>
                            </div>
                        ) : (
                            <button onClick={() => {
                                setSelectedEmployeeId(emp.id);
                                const [y, m] = selectedMonth.split('-');
                                const days = getDaysInMonth(y, m);
                                const today = new Date();
                                let guessDate = `${selectedMonth}-${days}`;
                                if (today.getFullYear() == y && (today.getMonth()+1) == m) guessDate = `${selectedMonth}-${String(today.getDate()).padStart(2, '0')}`;
                                setPayModalData({ isCustom: false, customDate: guessDate, remarks: '' });
                                setIsPayModalOpen(true);
                            }} className="bg-success text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-md text-xs sm:text-sm font-medium shadow-sm hover:bg-green-700 transition-colors">Pay Now</button>
                        )}
                    </td>
                </tr>
            );
        });

        return (
            <div className="space-y-4 sm:space-y-6">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                    <div>
                        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Payday & Settlements</h1>
                        <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-1">
                            {selectedCafe === 'all' ? 'All Locations' : cafes.find(c => c.id === selectedCafe)?.name}
                        </p>
                    </div>
                   <div className="w-full sm:w-auto z-40"><ModernDropdown value={selectedMonth} onChange={setSelectedMonth} options={generateMonthOptions()} /></div>
                </div>
                
                <CafeSelector />
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                    <div className="bg-white dark:bg-amoled-card p-4 sm:p-6 rounded-xl border-l-4 border-warning shadow-sm"><p className="text-xs sm:text-sm text-gray-500">Pending</p><h3 className="text-xl sm:text-3xl font-bold dark:text-white mt-1">{formatMoney(totalPending)}</h3></div>
                    <div className="bg-white dark:bg-amoled-card p-4 sm:p-6 rounded-xl border-l-4 border-success shadow-sm"><p className="text-xs sm:text-sm text-gray-500">Settled</p><h3 className="text-xl sm:text-3xl font-bold dark:text-white mt-1">{formatMoney(totalSettled)}</h3></div>
                </div>

                <div className="sm:hidden space-y-3">
                    {relevantEmployees.length === 0 ? (
                        <div className="bg-white dark:bg-amoled-card rounded-xl p-6 text-center text-gray-500 dark:text-gray-400 italic">No employees found.</div>
                    ) : (
                        relevantEmployees.map(emp => {
                            const payInfo = calculatePay(emp, selectedMonth, null, logs);
                            const paymentRecord = (payments[emp.id] && payments[emp.id][selectedMonth]) ? payments[emp.id][selectedMonth] : null;
                            const isPaid = !!paymentRecord;
                            const cafe = cafes.find(c => c.id === emp.cafeId);
                            return (
                                <div key={emp.id} className="bg-white dark:bg-amoled-card rounded-xl shadow-sm border border-gray-200 dark:border-amoled-border p-4">
                                    <div className="flex items-center mb-3">
                                        <div className={`flex-shrink-0 h-10 w-10 rounded-full ${cafe?.color || 'bg-gray-500'} flex items-center justify-center text-white text-sm font-bold mr-3`}>{emp.profilePic ? <img src={emp.profilePic} alt={emp.name} className="h-full w-full rounded-full object-cover" /> : emp.name.charAt(0)}</div>
                                        <div className="flex-grow min-w-0">
                                            <div className="font-medium text-sm text-gray-900 dark:text-white truncate">{emp.name}</div>
                                            <div className="text-xs text-gray-500 truncate">{cafe?.name}</div>
                                        </div>
                                        {isPaid ? <span className="px-2 py-1 text-[10px] rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"><i className="fas fa-check mr-1"></i>Paid</span> : <span className="px-2 py-1 text-[10px] rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">Pending</span>}
                                    </div>
                                    <div className="flex justify-between items-center py-2 border-y dark:border-amoled-border mb-3">
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase">Net Pay</div>
                                            <div className="text-sm font-bold dark:text-white">{isPaid ? formatMoney(paymentRecord.amount) : formatMoney(payInfo.net)}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-[10px] text-gray-500 uppercase">Period</div>
                                            <div className="text-xs dark:text-gray-300">{isPaid ? (paymentRecord.type === 'partial' ? `To ${formatDateDisplay(paymentRecord.customEndDate)}` : 'Full Month') : 'Pending'}</div>
                                        </div>
                                    </div>
                                    {isPaid ? (
                                        <button onClick={() => downloadPayslip(emp.id, selectedMonth)} className="w-full text-xs bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 px-3 py-2 rounded-md border"><i className="fas fa-file-pdf text-red-500 mr-1.5"></i>Download PDF</button>
                                    ) : (
                                        <button onClick={() => {
                                            setSelectedEmployeeId(emp.id);
                                            const [y, m] = selectedMonth.split('-');
                                            const days = getDaysInMonth(y, m);
                                            const today = new Date();
                                            let guessDate = `${selectedMonth}-${days}`;
                                            if (today.getFullYear() == y && (today.getMonth()+1) == m) guessDate = `${selectedMonth}-${String(today.getDate()).padStart(2, '0')}`;
                                            setPayModalData({ isCustom: false, customDate: guessDate, remarks: '' });
                                            setIsPayModalOpen(true);
                                        }} className="w-full bg-success text-white px-4 py-2 rounded-md text-sm font-medium shadow-sm hover:bg-green-700">Pay Now</button>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="hidden sm:block bg-white dark:bg-amoled-card shadow-sm rounded-xl overflow-hidden border dark:border-amoled-border">
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 dark:divide-amoled-border">
                            <thead className="bg-gray-50 dark:bg-[#0a0a0a]">
                                <tr><th className="px-6 py-3 text-left text-xs text-gray-500">Employee</th><th className="hidden md:table-cell px-6 py-3 text-left text-xs text-gray-500">Period</th><th className="px-6 py-3 text-left text-xs text-gray-500">Net</th><th className="hidden sm:table-cell px-6 py-3 text-left text-xs text-gray-500">Status</th><th className="px-6 py-3 text-right text-xs text-gray-500">Action</th></tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-amoled-border">{rows.length > 0 ? rows : <tr><td colSpan="5" className="text-center py-8 text-gray-500 italic">No employees found.</td></tr>}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        );
    };

    const renderPayModal = () => {
        if (!isPayModalOpen) return null;
        const emp = employees.find(e => e.id === selectedEmployeeId);
        if (!emp) return null;

        const payInfo = calculatePay(emp, selectedMonth, payModalData.isCustom ? payModalData.customDate : null, logs);
        const typeLabels = {
            ...LOG_CATEGORIES,
            absence: 'Absence', late: 'Late Arrival', dress_code: 'Dress Code',
            no_clean: "Didn't Clean", performance: 'Performance', custom: 'Custom Issue'
        };

        const getOvertimeHours = (log) => {
            if (log.type !== 'bonus_overtime') return 0;
            if (Number.isFinite(Number(log.overtimeHours))) return Number(log.overtimeHours);
            const text = String(log.reason || '');
            const match = text.match(/Quick overtime\s*[•·]\s*([\d.]+)\s*hour/i) || text.match(/^\s*([\d.]+)\s*Hours\s+logged/i);
            return match ? Number(match[1]) : 0;
        };

        const [reviewYear, reviewMonth] = selectedMonth.split('-');
        const reviewDays = getDaysInMonth(reviewYear, reviewMonth);
        const cutoffDay = payModalData.isCustom && payModalData.customDate
            ? Number(String(payModalData.customDate).split('-')[2])
            : reviewDays;
        const attendanceSet = new Set(emp.attendance?.[selectedMonth] || []);
        const monthLogs = logs?.[emp.id]?.[selectedMonth] || [];
        const logsByDate = monthLogs.reduce((acc, log) => {
            if (!log?.date) return acc;
            (acc[log.date] ||= []).push(log);
            return acc;
        }, {});

        const reviewData = Array.from({ length: reviewDays }, (_, i) => {
            const day = i + 1;
            const dateStr = `${reviewYear}-${reviewMonth}-${String(day).padStart(2, '0')}`;
            const date = new Date(Number(reviewYear), Number(reviewMonth) - 1, day);
            const dayName = DAYS_OF_WEEK[(date.getDay() + 6) % 7];
            const schedule = emp.schedule?.[dayName] || { shift: 'off', hours: '' };
            const planned = schedule.shift !== 'off' && !!schedule.hours;
            const worked = attendanceSet.has(dateStr);
            const dayLogs = logsByDate[dateStr] || [];
            const overtime = dayLogs.reduce((sum, log) => sum + getOvertimeHours(log), 0);
            const issues = dayLogs.filter(log => {
                const type = String(log.type || '');
                return !type.includes('bonus') && !type.includes('advance');
            });
            return { day, dateStr, planned, worked, hours: schedule.hours || '', overtime, issues, afterCutoff: day > cutoffDay };
        });

        const activeReview = reviewData.filter(d => !d.afterCutoff);
        const workedDays = activeReview.filter(d => d.worked).length;
        const plannedDays = activeReview.filter(d => d.planned).length;
        const absentDays = activeReview.filter(d => d.planned && !d.worked).length;
        const overtimeHours = activeReview.reduce((sum, d) => sum + d.overtime, 0);
        const issueDays = activeReview.filter(d => d.issues.length > 0).length;

        const renderModalCalendar = () => {
            const firstDay = new Date(Number(reviewYear), Number(reviewMonth) - 1, 1).getDay();
            const cells = Array.from({ length: firstDay }, (_, i) => (
                <div key={`empty-${i}`} className="aspect-square min-h-[52px] sm:min-h-[68px]" />
            ));

            reviewData.forEach(info => {
                const absent = info.planned && !info.worked && !info.afterCutoff;
                const tone = info.afterCutoff
                    ? 'border-white/[0.04] bg-black/[0.10] opacity-35'
                    : info.worked
                        ? 'border-emerald-400/40 bg-emerald-500/[0.10]'
                        : absent
                            ? 'border-red-400/35 bg-red-500/[0.07]'
                            : 'border-white/[0.07] bg-white/[0.018]';
                const numberTone = info.worked ? 'text-emerald-300' : absent ? 'text-red-300' : info.planned ? 'text-blue-200' : 'text-gray-500';
                cells.push(
                    <div key={info.dateStr}
                        title={`${info.day}${info.planned ? ` • Scheduled ${info.hours}` : ' • Day off'}${info.worked ? ' • Present' : absent ? ' • Absent' : ''}${info.overtime ? ` • +${info.overtime}h overtime` : ''}${info.issues.length ? ` • ${info.issues.length} issue(s)` : ''}`}
                        className={`relative aspect-square min-h-[52px] sm:min-h-[68px] rounded-xl border p-2 sm:p-2.5 transition-colors ${tone}`}>
                        <div className="flex items-start justify-between gap-1">
                            <span className={`text-xs sm:text-sm font-bold ${numberTone}`}>{info.day}</span>
                            <div className="flex items-center gap-1">
                                {info.overtime > 0 && <span className="text-[9px] sm:text-[10px] font-bold text-amber-300">⚡{info.overtime}h</span>}
                                {info.issues.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,.75)]" />}
                            </div>
                        </div>
                        {info.planned && (
                            <div className="absolute inset-x-2 bottom-2 sm:bottom-2.5 min-w-0">
                                <div className={`truncate text-[9px] sm:text-[10px] font-semibold ${info.worked ? 'text-emerald-300' : absent ? 'text-red-300' : 'text-blue-300/80'}`}>
                                    {info.worked ? <><i className="fas fa-check mr-1"></i>Present</> : absent ? <><i className="fas fa-times mr-1"></i>Absent</> : <><i className="far fa-clock mr-1"></i>{info.hours}</>}
                                </div>
                                {!info.worked && !absent && <div className="truncate mt-0.5 text-[8px] sm:text-[9px] text-gray-600">{info.hours}</div>}
                            </div>
                        )}
                    </div>
                );
            });
            return cells;
        };

        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 sm:p-4">
                <div className="w-full max-w-[1180px] max-h-[95vh] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-amoled-card flex flex-col">
                    <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-3 sm:px-6 sm:py-4 dark:border-amoled-border dark:bg-[#0a0a0a]">
                        <h3 className="text-base sm:text-lg font-semibold dark:text-white">Process Payment: <span className="text-primary">{emp.name}</span></h3>
                        <button onClick={() => setIsPayModalOpen(false)} className="p-1 text-gray-400 hover:text-white"><i className="fas fa-times"></i></button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6">
                        <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,0.85fr)_minmax(560px,1.45fr)] gap-5 lg:gap-7">
                            <div className="space-y-5 lg:pr-6 lg:border-r dark:border-amoled-border">
                                <div className="space-y-3">
                                    <label className="block text-sm font-semibold dark:text-gray-300">Payment Period</label>
                                    <label className="flex items-center gap-3 text-sm dark:text-gray-300"><input type="radio" checked={!payModalData.isCustom} onChange={() => setPayModalData({...payModalData, isCustom:false})} className="w-4 h-4 text-primary" /> Full Month (End of Month)</label>
                                    <label className="flex items-center gap-3 text-sm dark:text-gray-300"><input type="radio" checked={payModalData.isCustom} onChange={() => setPayModalData({...payModalData, isCustom:true})} className="w-4 h-4 text-primary" /> Partial Month / Early Departure</label>
                                    {payModalData.isCustom && <div className="pt-1"><label className="mb-1 block text-xs text-gray-500">Select Last Day Worked</label><ModernDatePicker value={payModalData.customDate} onChange={val => setPayModalData({...payModalData, customDate:val})} /></div>}
                                </div>
                                <div className="rounded-xl border bg-gray-50 p-4 space-y-3 dark:border-amoled-border dark:bg-[#0a0a0a]">
                                    <div className="flex justify-between text-sm"><span className="text-gray-500">Base Earned</span><span className="font-semibold dark:text-white">{formatMoney(payInfo.proratedBase)}</span></div>
                                    <div className="flex justify-between text-sm"><span className="text-gray-500">Total Deductions</span><span className="font-semibold text-danger">-{formatMoney(payInfo.deductions)}</span></div>
                                    <div className="flex justify-between items-center border-t pt-3 dark:border-amoled-border"><span className="font-bold dark:text-white">Final Net Pay</span><span className="text-xl font-bold text-success">{formatMoney(payInfo.net)}</span></div>
                                </div>
                                <div><label className="mb-1 block text-sm font-medium dark:text-gray-300">Payment Remarks</label><input type="text" value={payModalData.remarks} onChange={e => setPayModalData({...payModalData, remarks:e.target.value})} placeholder="e.g., Bank Transfer, Final settlement..." className="w-full rounded-lg border px-3 py-2.5 text-sm dark:border-zinc-700 dark:bg-amoled-surface dark:text-white" /></div>

                                <div className="rounded-xl border border-white/[0.08] bg-[#0b0f14] p-3.5 sm:p-4">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div>
                                            <h4 className="text-sm font-semibold text-white">Applied bonuses & deductions</h4>
                                            <p className="mt-0.5 text-[11px] text-gray-500">Review every financial adjustment before payment.</p>
                                        </div>
                                        <div className="flex items-center gap-2 text-[10px] sm:text-xs whitespace-nowrap">
                                            {payInfo.bonuses > 0 && <span className="rounded-md bg-emerald-500/[.09] px-2 py-1 font-semibold text-emerald-300">+{formatMoney(payInfo.bonuses)}</span>}
                                            {payInfo.deductions > 0 && <span className="rounded-md bg-red-500/[.08] px-2 py-1 font-semibold text-red-300">-{formatMoney(payInfo.deductions)}</span>}
                                        </div>
                                    </div>
                                    <div className="max-h-[250px] sm:max-h-[300px] overflow-y-auto pr-1">
                                        {payInfo.breakdown.length === 0 ? (
                                            <div className="py-6 text-center text-xs text-gray-600">No bonuses or deductions recorded for this month.</div>
                                        ) : (
                                            [...payInfo.breakdown].sort((a, b) => new Date(b.date) - new Date(a.date)).map(log => {
                                                const isBonus = String(log.type || '').includes('bonus');
                                                const isAdvance = String(log.type || '').includes('advance');
                                                const amountClass = isBonus ? 'text-emerald-300' : isAdvance ? 'text-blue-300' : 'text-red-300';
                                                const sign = isBonus ? '+' : '-';
                                                return (
                                                    <div key={log.id} className="flex items-start justify-between gap-3 border-b border-white/[0.07] py-3 last:border-b-0">
                                                        <div className="min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-xs font-semibold text-gray-300">{formatDateDisplay(log.date)}</span>
                                                                <span className={`text-[10px] font-medium ${isBonus ? 'text-emerald-400' : isAdvance ? 'text-blue-400' : 'text-red-400'}`}>{isBonus ? 'Bonus' : isAdvance ? 'Advance' : 'Deduction'}</span>
                                                            </div>
                                                            <p className="mt-1 truncate text-xs text-gray-500" title={log.reason || typeLabels[log.type] || log.type}>{log.reason || typeLabels[log.type] || log.type}</p>
                                                        </div>
                                                        <span className={`shrink-0 text-sm font-semibold ${amountClass}`}>{sign}{formatMoney(log.appliedAmount)}</span>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="rounded-2xl border border-white/[0.08] bg-[#0d1118] p-3 sm:p-4 lg:p-5 shadow-[0_16px_45px_rgba(0,0,0,.22)]">
                                    <div className="mb-4 flex items-center justify-between gap-3">
                                        <div><h4 className="text-base sm:text-lg font-semibold text-white">Attendance review</h4><p className="mt-0.5 text-xs text-gray-500">Quick monthly check before confirming payment.</p></div>
                                        <div className="hidden sm:flex items-center gap-4 text-right text-xs"><span><b className="block text-base text-emerald-300">{workedDays}</b><span className="text-gray-500">worked</span></span><span><b className="block text-base text-red-300">{absentDays}</b><span className="text-gray-500">absent</span></span><span><b className="block text-base text-amber-300">{overtimeHours}h</b><span className="text-gray-500">overtime</span></span></div>
                                    </div>
                                    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] sm:text-xs text-gray-500"><span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>Present</span><span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-red-400"/>Absent</span><span>⚡ Overtime</span><span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-red-400"/>Issue</span><span className="ml-auto text-gray-600">{plannedDays} scheduled days</span></div>
                                    <div className="grid grid-cols-7 gap-1.5 sm:gap-2 mb-1.5 text-center text-[9px] sm:text-[10px] font-semibold uppercase tracking-wide text-gray-500"><div>Su</div><div>Mo</div><div>Tu</div><div>We</div><div>Th</div><div>Fr</div><div>Sa</div></div>
                                    <div className="grid grid-cols-7 gap-1.5 sm:gap-2">{renderModalCalendar()}</div>
                                    <div className="sm:hidden mt-3 grid grid-cols-3 gap-2 text-center text-[10px]"><div className="rounded-lg bg-emerald-500/[.08] py-2 text-emerald-300"><b className="block text-sm">{workedDays}</b>Worked</div><div className="rounded-lg bg-red-500/[.07] py-2 text-red-300"><b className="block text-sm">{absentDays}</b>Absent</div><div className="rounded-lg bg-amber-500/[.07] py-2 text-amber-300"><b className="block text-sm">{overtimeHours}h</b>Overtime</div></div>
                                </div>
                                {issueDays > 0 && <div className="mt-3 rounded-xl border border-red-400/15 bg-red-500/[.035] px-3 py-2 text-xs text-red-200/80"><span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-red-400" />{issueDays} day{issueDays > 1 ? 's' : ''} with logged issues or deductions.</div>}
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-col-reverse gap-2 border-t bg-gray-50 px-4 py-3 sm:flex-row sm:justify-end sm:px-6 dark:border-amoled-border dark:bg-[#0a0a0a]">
                        <button onClick={() => setIsPayModalOpen(false)} className="w-full sm:w-auto rounded-lg border px-5 py-2.5 text-sm dark:border-zinc-700 dark:bg-amoled-surface dark:text-gray-300">Cancel</button>
                        <button disabled={isSavingPayment} onClick={async () => {
                            const paymentLockKey = `payment-${emp.id}-${selectedMonth}`;
                            if (!lockSubmission(paymentLockKey)) return;
                            setIsSavingPayment(true);
                            try {
                                const paymentData = { employeeId:emp.id, month:selectedMonth, amount:payInfo.net, type:payModalData.isCustom?'partial':'full', customEndDate:payModalData.isCustom?payModalData.customDate:null, datePaid:new Date().toISOString().split('T')[0], remarks:payModalData.remarks };
                                const docRef = await addDoc(collection(db,'payments'), paymentData);
                                setPayments({...payments,[emp.id]:{...(payments[emp.id]||{}),[selectedMonth]:{id:docRef.id,...paymentData}}});
                                setIsPayModalOpen(false);
                            } catch (error) { console.error('Error saving payment:',error); setAlertConfig({isOpen:true,title:'Error',message:'Failed to save payment.',onConfirm:()=>setAlertConfig(prev=>({...prev,isOpen:false}))}); }
                            finally { setIsSavingPayment(false); unlockSubmission(paymentLockKey); }
                        }} className="w-full sm:w-auto rounded-lg bg-success px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60">{isSavingPayment ? <><i className="fas fa-spinner fa-spin mr-2"/>Saving...</> : <><i className="fas fa-check-circle mr-2"/>Confirm & Mark Paid</>}</button>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className={`relative isolate min-h-screen flex flex-col bg-gray-100 dark:bg-amoled text-gray-800 dark:text-gray-200 font-sans overflow-x-hidden`}>
            <LiquidNightBackground theme={theme} />
            <div className="relative z-10 flex min-h-screen flex-col">
            <style>{`

                /* Responsive application scale:
                   - phone: edge-to-edge breathing room without horizontal overflow
                   - laptop: comfortably fills the viewport
                   - large desktop: uses more of the available canvas, so 100% browser zoom
                     already feels like the intended layout instead of looking tiny */
                .corp-layout-shell {
                    width: 100%;
                    max-width: 88rem;
                }
                @media (min-width: 1280px) {
                    .corp-layout-shell {
                        max-width: 92rem;
                    }
                }
                @media (min-width: 1536px) {
                    .corp-layout-shell {
                        max-width: 96rem;
                    }
                }
                @media (max-width: 767px) {
                    .corp-layout-shell {
                        max-width: 100%;
                    }
                }

                .corp-aurora-bg {
                    --mx: 50%;
                    --my: 36%;
                    --scroll-shift: 0px;
                    background:
                        radial-gradient(900px 620px at 12% calc(4% + var(--scroll-shift)), rgba(28, 78, 142, .16), transparent 66%),
                        radial-gradient(760px 540px at 90% 18%, rgba(82, 42, 148, .12), transparent 68%),
                        radial-gradient(600px 460px at 48% 104%, rgba(0, 137, 150, .075), transparent 70%),
                        #05070a;
                    isolation: isolate;
                }
                .corp-aurora-bg::before {
                    content: "";
                    position: absolute;
                    inset: -20%;
                    opacity: .62;
                    background:
                        linear-gradient(118deg, transparent 24%, rgba(41, 101, 179, .075) 43%, transparent 58%),
                        linear-gradient(292deg, transparent 32%, rgba(132, 72, 194, .055) 50%, transparent 67%);
                    filter: blur(34px);
                    transform: translate3d(0, calc(var(--scroll-shift) * -.3), 0);
                }
                .corp-aurora {
                    position: absolute;
                    border-radius: 999px;
                    filter: blur(90px);
                    mix-blend-mode: screen;
                    opacity: .22;
                    will-change: transform;
                }
                .corp-aurora-a {
                    width: 48vw;
                    height: 34vw;
                    min-width: 420px;
                    min-height: 300px;
                    left: -18vw;
                    top: 18vh;
                    background: radial-gradient(ellipse, rgba(26, 97, 182, .48), rgba(33, 69, 134, .08) 52%, transparent 72%);
                    animation: corpAuroraDriftA 18s ease-in-out infinite alternate;
                }
                .corp-aurora-b {
                    width: 42vw;
                    height: 30vw;
                    min-width: 360px;
                    min-height: 260px;
                    right: -16vw;
                    top: 7vh;
                    background: radial-gradient(ellipse, rgba(111, 61, 183, .38), rgba(60, 55, 140, .06) 54%, transparent 74%);
                    animation: corpAuroraDriftB 22s ease-in-out infinite alternate;
                }
                .corp-pointer-glow {
                    position: absolute;
                    width: 420px;
                    height: 420px;
                    left: calc(var(--mx) - 210px);
                    top: calc(var(--my) - 210px);
                    border-radius: 999px;
                    background: radial-gradient(circle, rgba(83, 135, 255, .10), rgba(84, 88, 205, .035) 34%, transparent 70%);
                    filter: blur(14px);
                    mix-blend-mode: screen;
                    transition: opacity .25s ease;
                    opacity: .78;
                    will-change: left, top;
                }
                .corp-aurora-bg canvas {
                    position: absolute !important;
                    inset: 0;
                    display: block;
                    width: 100% !important;
                    height: 100% !important;
                    opacity: .72;
                    mix-blend-mode: screen;
                }
                .corp-motion-reduced .corp-aurora {
                    animation: none;
                }
                .corp-motion-reduced .corp-pointer-glow {
                    display: none;
                }


                @keyframes corpAuroraDriftA {
                    from { transform: translate3d(-1vw, -1vh, 0) scale(1); }
                    to { transform: translate3d(7vw, 5vh, 0) scale(1.12); }
                }
                @keyframes corpAuroraDriftB {
                    from { transform: translate3d(2vw, 0, 0) scale(1.02); }
                    to { transform: translate3d(-7vw, 8vh, 0) scale(1.14); }
                }
                @media (max-width: 767px) {
                    .corp-aurora-a { opacity: .16; }
                    .corp-aurora-b { opacity: .14; }
                    .corp-pointer-glow { display: none; }
                }

                @keyframes corpGlassRise {
                    from { opacity: 0; transform: translateY(10px) scale(.985); filter: blur(3px); }
                    to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
                }
                @keyframes corpGlassPop {
                    from { opacity: 0; transform: translateY(8px) scale(.97); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes corpTimelineSlide {
                    from { opacity: 0; transform: translateX(10px); filter: blur(2px); }
                    to { opacity: 1; transform: translateX(0); filter: blur(0); }
                }
                .corp-timeline-slide { animation: corpTimelineSlide .34s cubic-bezier(.22,.61,.36,1) both; }
                .corp-glass-enter { animation: corpGlassRise .42s cubic-bezier(.22,.8,.22,1) both; }
                .corp-pop-enter { animation: corpGlassPop .28s cubic-bezier(.22,.8,.22,1) both; }
                @media (prefers-reduced-motion: reduce) {
                    .corp-glass-enter, .corp-pop-enter { animation: none !important; }
                }
            `}</style>
            <nav className="bg-white shadow-sm border-b dark:bg-[#050505] dark:border-amoled-border sticky top-0 z-30">
                <div className="corp-layout-shell mx-auto px-3 sm:px-5 lg:px-7 xl:px-8">
                    <div className="flex justify-between h-14 sm:h-16">
                        <div className="flex items-center cursor-pointer" onClick={handleLogoClick}>
                            <i className="fas fa-building text-primary text-xl sm:text-2xl mr-2 sm:mr-3"></i>
                            <span className="font-bold text-lg sm:text-xl dark:text-white tracking-tight">CorpPay</span>
                        </div>
                        
                        <div className="hidden md:flex items-center space-x-2 lg:space-x-4">
                            <button onClick={() => setCurrentView('dashboard')} className={`text-sm font-medium px-3 py-2 rounded-xl transition-all duration-200 ${currentView === 'dashboard' ? 'bg-primary/10 text-primary shadow-sm ring-1 ring-primary/15' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'}`}>Dashboard</button>
                            <button onClick={() => setCurrentView('payday')} className={`text-sm font-medium px-3 py-2 rounded-xl transition-all duration-200 flex items-center gap-1 ${currentView === 'payday' ? 'bg-green-500/10 text-green-600 shadow-sm ring-1 ring-green-500/15' : 'text-gray-500 hover:text-green-600 dark:text-gray-400 dark:hover:text-green-400'}`}><i className="fas fa-file-invoice-dollar"></i> Payday</button>
                            <button onClick={() => setCurrentView('employees')} className={`text-sm font-medium px-3 py-2 rounded-xl transition-all duration-200 ${currentView.includes('employee') ? 'bg-primary/10 text-primary shadow-sm ring-1 ring-primary/15' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'}`}>Employees</button>
                            <button onClick={() => setCurrentView('roles')} className={`text-sm font-medium px-3 py-2 rounded-xl transition-all duration-200 flex items-center gap-1 ${currentView === 'roles' ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 shadow-sm ring-1 ring-purple-500/15' : 'text-gray-500 hover:text-purple-600 dark:text-gray-400 dark:hover:text-purple-400'}`}><i className="fas fa-briefcase"></i> Roles</button>
                            <div className="h-6 w-px bg-gray-300 dark:bg-zinc-700 mx-1 lg:mx-2"></div>
                            <button onClick={toggleTheme} className="p-2 text-gray-500 hover:text-yellow-500 dark:text-gray-400"><i className={`fas ${theme === 'dark' ? 'fa-sun text-yellow-500' : 'fa-moon'}`}></i></button>
                            <button onClick={handleLogout} className="p-2 text-gray-500 hover:text-red-500 dark:text-gray-400"><i className="fas fa-sign-out-alt"></i></button>
                        </div>

                        <div className="flex md:hidden items-center space-x-2">
                            <button onClick={toggleTheme} className="p-2 text-gray-500 hover:text-yellow-500 dark:text-gray-400"><i className={`fas ${theme === 'dark' ? 'fa-sun text-yellow-500' : 'fa-moon'}`}></i></button>
                            <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="p-2 text-gray-500 dark:text-gray-400">
                                <i className={`fas ${mobileMenuOpen ? 'fa-times' : 'fa-bars'} text-xl`}></i>
                            </button>
                        </div>
                    </div>
                </div>

                {mobileMenuOpen && (
                    <div className="md:hidden border-t border-gray-200 dark:border-amoled-border bg-white dark:bg-[#050505]">
                        <div className="px-3 py-2 space-y-1">
                            <button onClick={() => { setCurrentView('dashboard'); setMobileMenuOpen(false); }} className={`block w-full text-left px-3 py-2 rounded-md text-sm font-medium ${currentView === 'dashboard' ? 'bg-primary/10 text-primary' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
                                <i className="fas fa-chart-line mr-2"></i>Dashboard
                            </button>
                            <button onClick={() => { setCurrentView('payday'); setMobileMenuOpen(false); }} className={`block w-full text-left px-3 py-2 rounded-md text-sm font-medium ${currentView === 'payday' ? 'bg-green-500/10 text-green-600' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
                                <i className="fas fa-file-invoice-dollar mr-2"></i>Payday
                            </button>
                            <button onClick={() => { setCurrentView('employees'); setMobileMenuOpen(false); }} className={`block w-full text-left px-3 py-2 rounded-md text-sm font-medium ${currentView.includes('employee') ? 'bg-primary/10 text-primary' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
                                <i className="fas fa-users mr-2"></i>Employees
                            </button>
                            <button onClick={() => { setCurrentView('roles'); setMobileMenuOpen(false); }} className={`block w-full text-left px-3 py-2 rounded-md text-sm font-medium ${currentView === 'roles' ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}><i className="fas fa-briefcase mr-2"></i>Roles</button>
                            <div className="border-t border-gray-200 dark:border-amoled-border my-2"></div>
                            <button onClick={handleLogout} className="block w-full text-left px-3 py-2 rounded-md text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                                <i className="fas fa-sign-out-alt mr-2"></i>Logout
                            </button>
                        </div>
                    </div>
                )}
            </nav>

            {toast && (
                <div className="fixed right-4 top-20 z-[500] max-w-sm animate-[fadeIn_.25s_ease-out]">
                    <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-2xl ${toast.type === 'error' ? 'border-red-400/25 bg-red-500/10 text-red-100' : 'border-white/20 bg-black/45 text-white'}`}>
                        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${toast.type === 'error' ? 'bg-red-500/20 text-red-300' : 'bg-primary/20 text-primary'}`}><i className={`fas ${toast.type === 'error' ? 'fa-exclamation-triangle' : 'fa-check'}`}></i></span>
                        <span className="flex-1 text-sm font-semibold">{toast.message}</span>
                        <button type="button" onClick={() => setToast(null)} className="text-white/60 transition hover:text-white"><i className="fas fa-times"></i></button>
                    </div>
                </div>
            )}

            <main className="corp-layout-shell flex-grow w-full mx-auto px-3 sm:px-5 lg:px-7 xl:px-8 py-4 sm:py-6 lg:py-8">
                {currentView === 'dashboard' && renderDashboard()}
                {currentView === 'employees' && renderEmployees()}
                {currentView === 'payday' && renderPayday()}
                {currentView === 'roles' && renderRoles()}
                {currentView === 'employee-detail' && renderEmployeeDetail()}
            </main>

            {isAddingRole && (
                <div className="fixed inset-0 z-[85] flex items-center justify-center p-4 sm:p-6">
                    <div className="absolute inset-0 bg-black/55 backdrop-blur-xl" onClick={() => !isSavingRole && setIsAddingRole(false)}></div>
                    <div className="relative isolate w-full max-w-md overflow-hidden rounded-[32px] border border-white/45 dark:border-white/15 bg-white/55 dark:bg-[#0d1118]/78 shadow-[0_30px_100px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.16)] backdrop-blur-[32px] fade-in">
                        <div className="pointer-events-none absolute -left-20 -top-24 h-52 w-52 rounded-full bg-blue-400/30 blur-3xl"></div>
                        <div className="pointer-events-none absolute -right-16 bottom-0 h-48 w-48 rounded-full bg-purple-500/25 blur-3xl"></div>
                        <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/90 to-transparent"></div>
                        <div className="relative p-5 sm:p-7">
                            <div className="mb-7 flex items-start justify-between gap-4">
                                <div className="flex items-center gap-4">
                                    <div className="flex h-14 w-14 items-center justify-center rounded-[20px] border border-white/35 bg-white/30 dark:bg-white/[0.10] text-primary shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_12px_30px_rgba(0,0,0,.12)] backdrop-blur-xl"><i className="fas fa-plus text-lg"></i></div>
                                    <div><h3 className="text-xl font-bold tracking-tight text-gray-900 dark:text-white">Add Role</h3><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Create a reusable salary preset.</p></div>
                                </div>
                                <button type="button" disabled={isSavingRole} onClick={() => setIsAddingRole(false)} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-white/20 text-gray-500 shadow-sm backdrop-blur-xl transition hover:bg-white/45 hover:text-gray-900 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-white/15 dark:hover:text-white"><i className="fas fa-times"></i></button>
                            </div>
                            <div className="space-y-5">
                                <div><label className="mb-2 block text-[11px] font-bold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">Role Name</label><input autoFocus disabled={isSavingRole} value={newRoleName} onChange={e => setNewRoleName(e.target.value)} placeholder="e.g. Barista" className="w-full rounded-[20px] border border-white/45 dark:border-white/10 bg-white/35 dark:bg-black/20 px-4 py-3.5 text-sm text-gray-900 shadow-[inset_0_1px_0_rgba(255,255,255,.28)] outline-none backdrop-blur-xl transition focus:border-primary/60 focus:bg-white/50 focus:ring-4 focus:ring-primary/10 disabled:opacity-60 dark:text-white" /></div>
                                <div><label className="mb-2 block text-[11px] font-bold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">Monthly Salary (KZT)</label><input disabled={isSavingRole} value={newRoleSalary} onChange={e => setNewRoleSalary(e.target.value)} type="number" min="0" placeholder="e.g. 250000" className="w-full rounded-[20px] border border-white/45 dark:border-white/10 bg-white/35 dark:bg-black/20 px-4 py-3.5 text-sm text-gray-900 shadow-[inset_0_1px_0_rgba(255,255,255,.28)] outline-none backdrop-blur-xl transition focus:border-primary/60 focus:bg-white/50 focus:ring-4 focus:ring-primary/10 disabled:opacity-60 dark:text-white" /></div>
                            </div>
                            <div className="mt-8 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                <button type="button" disabled={isSavingRole} onClick={() => setIsAddingRole(false)} className="rounded-2xl border border-white/35 bg-white/25 px-5 py-3 text-sm font-semibold text-gray-700 shadow-sm backdrop-blur-xl transition hover:bg-white/45 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.12]">Cancel</button>
                                <button type="button" disabled={isSavingRole} onClick={async () => { if (await saveRole(newRoleName, newRoleSalary)) { setIsAddingRole(false); setNewRoleName(''); setNewRoleSalary(''); } }} className="rounded-2xl border border-white/25 bg-gradient-to-br from-blue-500 to-primary px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(37,99,235,.32),inset_0_1px_0_rgba(255,255,255,.35)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60">{isSavingRole ? <><i className="fas fa-spinner fa-spin mr-2"></i>Adding...</> : <><i className="fas fa-plus mr-2"></i>Add Role</>}</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {isAddEmpOpen && (
                <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 sm:p-6">
                    <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => !isAddingEmployee && setIsAddEmpOpen(false)}></div>
                    <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-[#111318] shadow-2xl fade-in">
                        <div className="h-1 bg-gradient-to-r from-primary via-blue-400 to-purple-500"></div>
                        <div className="p-5 sm:p-7">
                            <div className="mb-7 flex items-start justify-between gap-4">
                                <div className="flex gap-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20"><i className="fas fa-user-plus text-lg"></i></div><div><h3 className="text-xl font-bold tracking-tight text-gray-900 dark:text-white">Hire New Employee</h3><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Add their details and assign a cafe location.</p></div></div>
                                <button type="button" onClick={() => !isAddingEmployee && setIsAddEmpOpen(false)} disabled={isAddingEmployee} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-zinc-800"><i className="fas fa-times"></i></button>
                            </div>
                            <form onSubmit={async (e) => {
                                e.preventDefault();
                                if (!lockSubmission('add-employee')) return;
                                setIsAddingEmployee(true);
                                if (employees.filter(emp => emp.status === 'active').length >= 150) {
                                    unlockSubmission('add-employee'); setIsAddingEmployee(false);
                                    setAlertConfig({ isOpen: true, title: "Limit Reached", message: "Maximum 150 active employees allowed.", onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) }); return;
                                }
                                const defaultSchedule = {
                                    monday: { shift: 'morning', hours: '09:00-18:00' }, tuesday: { shift: 'morning', hours: '09:00-18:00' },
                                    wednesday: { shift: 'evening', hours: '14:00-23:00' }, thursday: { shift: 'evening', hours: '14:00-23:00' },
                                    friday: { shift: 'all', hours: '09:00-21:00' }, saturday: { shift: 'all', hours: '10:00-20:00' }, sunday: { shift: 'off', hours: '' }
                                };
                                try {
                                    let profilePicUrl = '';
                                    const file = e.target.profilePic.files[0];
                                    if (file) profilePicUrl = await compressImage(file);
                                    const selectedRole = e.target.role.value.trim();
                                    const roleTemplate = getRoleTemplate(selectedRole);
                                    const resolvedSalary = parseFloat(e.target.salary.value || (roleTemplate ? roleTemplate.salary : 0));
                                    const newEmployee = { name: e.target.name.value.trim(), role: selectedRole, baseSalary: resolvedSalary, status: 'active', cafeId: e.target.cafe.value, profilePic: profilePicUrl, schedule: defaultSchedule, remarks: '' };
                                    const docRef = await addDoc(collection(db, 'employees'), newEmployee);
                                    setEmployees(prev => [...prev, { id: docRef.id, ...newEmployee }]);
                                    setIsAddEmpOpen(false);
                                    setHireRole(''); setHireSalary('');
                                } catch (error) {
                                    console.error('Error adding employee:', error);
                                    setAlertConfig({ isOpen: true, title: 'Error', message: 'Failed to add employee.', onConfirm: () => setAlertConfig(prev => ({...prev, isOpen: false})) });
                                } finally { unlockSubmission('add-employee'); setIsAddingEmployee(false); }
                            }} className="space-y-5">
                                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                                    <div className="sm:col-span-2"><label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Full Name</label><div className="relative"><i className="fas fa-user absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400"></i><input name="name" required autoFocus placeholder="Employee's full name" className="w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-black/30 py-3 pl-9 pr-3 text-sm text-gray-900 dark:text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" /></div></div>
                                    <div><label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Role</label><div className="relative"><i className="fas fa-briefcase absolute left-3 top-[1.55rem] -translate-y-1/2 z-10 text-xs text-gray-400"></i><input name="role" required value={hireRole} onFocus={() => setIsHireRolePickerOpen(true)} onChange={e => { const value = e.target.value; setHireRole(value); setIsHireRolePickerOpen(true); const template = getRoleTemplate(value); if (template) setHireSalary(String(template.salary ?? '')); }} placeholder="Type a role or choose a saved one" className="w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-black/30 py-3 pl-9 pr-11 text-sm text-gray-900 dark:text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" /><button type="button" onClick={() => setIsHireRolePickerOpen(prev => !prev)} className="absolute right-2 top-1/2 z-20 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg bg-primary/10 text-primary transition hover:bg-primary hover:text-white" title="Choose saved role"><i className="fas fa-layer-group text-[11px]"></i></button>{isHireRolePickerOpen && <div className="absolute z-40 mt-2 w-full overflow-hidden rounded-2xl border border-white/20 bg-white/90 p-2 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-[#12151d]/95"><div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">Saved Roles</div>{roles.filter(role => !hireRole || String(role.name).toLowerCase().includes(hireRole.toLowerCase())).length > 0 ? <div className="max-h-52 space-y-1 overflow-y-auto">{roles.filter(role => !hireRole || String(role.name).toLowerCase().includes(hireRole.toLowerCase())).map(role => <button key={role.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setHireRole(role.name); setHireSalary(String(role.salary ?? '')); setIsHireRolePickerOpen(false); }} className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition hover:bg-primary/10"><span className="flex items-center gap-2 font-medium text-gray-800 dark:text-gray-100"><i className="fas fa-briefcase text-[10px] text-primary"></i>{role.name}</span><span className="text-xs font-semibold text-primary">{formatMoney(role.salary || 0)}</span></button>)}</div> : <div className="rounded-xl px-3 py-3 text-xs text-gray-500">No saved role matches. Keep typing to use a custom role.</div>}<div className="mt-1 border-t border-gray-200/70 px-3 pt-2 text-[10px] text-gray-400 dark:border-white/10">You can always type a custom role.</div></div>}</div><p className="mt-1.5 text-[10px] text-gray-400">Choose a saved role to auto-fill salary, or type your own.</p></div>
                                    <div><label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Base Salary (KZT)</label><div className="relative"><i className="fas fa-wallet absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400"></i><input name="salary" value={hireSalary} onChange={e => setHireSalary(e.target.value)} type="number" required min="1" placeholder="e.g. 250000" className="w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-black/30 py-3 pl-9 pr-3 text-sm text-gray-900 dark:text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" /></div></div>
                                </div>
                                <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50/70 dark:bg-white/[0.02] p-4"><label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Profile Photo <span className="normal-case font-normal">(Optional)</span></label><input name="profilePic" type="file" accept="image/*" className="w-full cursor-pointer rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-black/30 p-1.5 text-sm text-gray-500 dark:text-gray-300 file:mr-4 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-primary hover:file:bg-primary/20" /></div>
                                <div><label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Cafe Location</label><div className="relative"><i className="fas fa-store absolute left-3 top-1/2 z-10 -translate-y-1/2 text-xs text-gray-400"></i><select name="cafe" required className="w-full appearance-none rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-black/30 py-3 pl-9 pr-10 text-sm text-gray-900 dark:text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20">{cafes.map(cafe => <option key={cafe.id} value={cafe.id}>{cafe.name} {cafe.location && `- ${cafe.location}`}</option>)}</select><i className="fas fa-chevron-down pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400"></i></div></div>
                                <div className="mt-2 flex flex-col-reverse gap-2 border-t border-gray-100 pt-5 dark:border-zinc-800 sm:flex-row sm:justify-end"><button type="button" disabled={isAddingEmployee} onClick={() => setIsAddEmpOpen(false)} className="rounded-xl border border-gray-200 dark:border-zinc-700 px-5 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-zinc-800">Cancel</button><button type="submit" disabled={isAddingEmployee} className="rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">{isAddingEmployee ? <><i className="fas fa-spinner fa-spin mr-2"></i>Adding Employee...</> : <><i className="fas fa-user-plus mr-2"></i>Add Employee</>}</button></div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {roleActionModal.isOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
                    <div className="absolute inset-0 bg-black/75 backdrop-blur-md" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRoleActionModal(); }}></div>
                    <div className={`relative w-full max-w-md overflow-hidden rounded-[30px] border p-[1px] shadow-[0_28px_100px_rgba(0,0,0,.58)] backdrop-blur-3xl ${roleActionModal.mode === 'delete' ? 'border-red-400/30 bg-gradient-to-br from-red-300/35 via-white/10 to-rose-500/25 dark:from-red-400/25 dark:via-white/[0.08] dark:to-rose-500/20' : 'border-white/20 bg-gradient-to-br from-blue-300/25 via-white/10 to-purple-500/20'}`}>
                        <div className={`absolute -left-16 -top-20 h-52 w-52 rounded-full blur-3xl ${roleActionModal.mode === 'delete' ? 'bg-red-500/25' : 'bg-blue-500/20'}`}></div>
                        <div className={`absolute -bottom-24 -right-16 h-60 w-60 rounded-full blur-3xl ${roleActionModal.mode === 'delete' ? 'bg-rose-500/20' : 'bg-purple-500/20'}`}></div>
                        <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"></div>
                        <div className={`relative m-[1px] rounded-[29px] border border-white/10 bg-white/55 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,.45)] backdrop-blur-[32px] sm:p-7 dark:bg-[#151922]/72 dark:shadow-[inset_0_1px_0_rgba(255,255,255,.08)]`}>
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex gap-4">
                                    <div className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] border shadow-[inset_0_1px_0_rgba(255,255,255,.22),0_10px_30px_rgba(0,0,0,.16)] backdrop-blur-2xl ${roleActionModal.mode === 'delete' ? 'border-red-300/25 bg-gradient-to-br from-red-500/30 to-rose-500/10 text-red-400' : 'border-primary/20 bg-primary/10 text-primary'}`}>
                                        <i className={`fas ${roleActionModal.mode === 'delete' ? 'fa-trash-alt' : 'fa-pen-to-square'} text-lg`}></i>
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-bold tracking-tight text-gray-900 dark:text-white">{roleActionModal.mode === 'delete' ? 'Delete Role' : 'Edit Role Preset'}</h3>
                                        <p className="mt-1 text-sm leading-6 text-gray-500 dark:text-gray-400">
                                            {roleActionModal.mode === 'delete'
                                                ? `Delete “${roleActionModal.role?.name}”? Employees already using it will keep their current role and salary.`
                                                : 'Update this saved role and its default monthly salary.'}
                                        </p>
                                    </div>
                                </div>
                                <button type="button" disabled={isSavingRole || isDeletingRole} onClick={closeRoleActionModal} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-gray-400 transition hover:bg-black/5 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-white/5 dark:hover:text-white" aria-label="Close"><i className="fas fa-times"></i></button>
                            </div>

                            {roleActionModal.mode === 'edit' && (
                                <div className="mt-7 space-y-4">
                                    <div>
                                        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Role Name</label>
                                        <div className="relative">
                                            <i className="fas fa-briefcase absolute left-4 top-1/2 -translate-y-1/2 text-xs text-gray-400"></i>
                                            <input autoFocus disabled={isSavingRole} value={roleActionModal.name} onChange={e => setRoleActionModal(prev => ({ ...prev, name: e.target.value }))} className="w-full rounded-2xl border border-gray-200 bg-gray-50 py-3.5 pl-10 pr-4 text-sm text-gray-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60 dark:border-white/10 dark:bg-black/25 dark:text-white" />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Monthly Salary (KZT)</label>
                                        <div className="relative">
                                            <i className="fas fa-wallet absolute left-4 top-1/2 -translate-y-1/2 text-xs text-gray-400"></i>
                                            <input disabled={isSavingRole} value={roleActionModal.salary} onChange={e => setRoleActionModal(prev => ({ ...prev, salary: e.target.value }))} type="number" min="0" step="0.01" className="w-full rounded-2xl border border-gray-200 bg-gray-50 py-3.5 pl-10 pr-4 text-sm text-gray-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60 dark:border-white/10 dark:bg-black/25 dark:text-white" />
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                                <button type="button" disabled={isSavingRole || isDeletingRole} onClick={closeRoleActionModal} className="rounded-2xl border border-white/20 bg-white/35 px-5 py-3 text-sm font-semibold text-gray-700 shadow-[inset_0_1px_0_rgba(255,255,255,.45)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-white/55 disabled:translate-y-0 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.035] dark:text-gray-200 dark:hover:bg-white/[0.08]">Cancel</button>
                                <button type="button" disabled={isSavingRole || isDeletingRole} onClick={submitRoleAction} className={`min-w-[152px] rounded-2xl border border-white/20 px-5 py-3 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,.3),0_14px_32px_rgba(0,0,0,.2)] backdrop-blur-xl transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 ${roleActionModal.mode === 'delete' ? 'bg-gradient-to-br from-red-400 via-red-500 to-rose-600 shadow-red-500/25 hover:brightness-110' : 'bg-primary shadow-primary/20 hover:bg-primary/90'}`}>
                                    {roleActionModal.mode === 'delete'
                                        ? (isDeletingRole ? <><i className="fas fa-spinner fa-spin mr-2"></i>Deleting...</> : <><i className="fas fa-trash-alt mr-2"></i>Delete Role</>)
                                        : (isSavingRole ? <><i className="fas fa-spinner fa-spin mr-2"></i>Updating...</> : <><i className="fas fa-check mr-2"></i>Update Role</>)}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {customModal.isOpen && (
                <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) closeCustomModal(); }}></div>
                    <div className="relative w-full max-w-md overflow-visible rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-[#111318] shadow-2xl fade-in">
                        <div className={`h-1 w-full ${customModal.danger ? 'bg-red-500' : 'bg-primary'}`}></div>
                        <div className="p-5 sm:p-6">
                            <div className="flex items-start gap-4">
                                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${customModal.danger ? 'bg-red-500/10 text-red-500' : 'bg-primary/10 text-primary'}`}><i className={`fas ${customModal.danger ? 'fa-trash-alt' : 'fa-pen-to-square'} text-base`}></i></div>
                                <div className="min-w-0 flex-1"><h3 className="text-lg font-bold text-gray-900 dark:text-white">{customModal.title}</h3>{customModal.description && <p className="mt-1.5 text-sm leading-6 text-gray-500 dark:text-gray-400">{customModal.description}</p>}</div>
                                <button type="button" disabled={isSavingCustomModal} onClick={closeCustomModal} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors disabled:opacity-40"><i className="fas fa-times"></i></button>
                            </div>
                            {customModal.fields.length > 0 && <div className="mt-6 space-y-4">{customModal.fields.map(field => <div key={field.name}><label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{field.label}</label>{field.type === 'role-picker' ? <div className="relative">
                                <div className="relative">
                                    {field.icon && <i className={`fas ${field.icon} absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400`}></i>}
                                    <input autoFocus disabled={isSavingCustomModal} value={customModal.values[field.name] ?? ''} onFocus={() => setIsCustomRolePickerOpen(true)} onChange={e => { const value = e.target.value; setCustomModal(prev => ({ ...prev, values: { ...prev.values, [field.name]: value } })); setIsCustomRolePickerOpen(true); }} className={`w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-black/30 py-3 pr-11 text-sm text-gray-900 dark:text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60 ${field.icon ? 'pl-9' : 'pl-3'}`} />
                                    <button type="button" disabled={isSavingCustomModal} onClick={() => setIsCustomRolePickerOpen(prev => !prev)} className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg bg-primary/10 text-primary transition hover:bg-primary hover:text-white disabled:opacity-50" title="Browse saved roles"><i className="fas fa-layer-group text-[11px]"></i></button>
                                </div>
                                {isCustomRolePickerOpen && <div className="absolute z-[110] mt-2 w-full overflow-hidden rounded-2xl border border-primary/20 bg-white/98 p-2 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-[#12151d]/98">
                                    <div className="flex items-center justify-between px-2 pb-2"><span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">Saved Roles</span><span className="text-[10px] text-gray-500">{roles.length} total</span></div>
                                    <div className="max-h-[min(420px,55vh)] space-y-1 overflow-y-auto pr-1">
                                    {[...roles].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''))).filter(role => { const q=String(customModal.values[field.name]||'').trim().toLowerCase(); return !q || String(role.name||'').toLowerCase().includes(q); }).map(role => <button key={role.id} type="button" disabled={isSavingCustomModal} onMouseDown={e => e.preventDefault()} onClick={() => { setCustomModal(prev => ({ ...prev, values: { ...prev.values, [field.name]: role.name } })); setIsCustomRolePickerOpen(false); }} className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-left transition hover:bg-primary/10 disabled:opacity-50"><span className="flex min-w-0 items-center gap-2 font-medium text-gray-800 dark:text-gray-100"><i className="fas fa-briefcase text-[10px] text-primary"></i><span className="truncate">{role.name}</span></span><span className="ml-3 shrink-0 text-xs font-semibold text-primary">{formatMoney(Number(role.salary)||0)}</span></button>)}
                                    </div>
                                    {roles.length === 0 && <div className="rounded-xl px-3 py-3 text-xs text-gray-500">No saved roles yet. You can still type a custom role.</div>}
                                    <div className="mt-2 border-t border-gray-200/70 px-3 pt-2 text-[10px] text-gray-400 dark:border-white/10">Choose a preset or type your own custom role.</div>
                                </div>}
                            </div> : <div className="relative">{field.icon && <i className={`fas ${field.icon} absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400`}></i>}<input disabled={isSavingCustomModal} autoFocus={customModal.fields[0]?.name === field.name} type={field.type || 'text'} step={field.step} value={customModal.values[field.name] ?? ''} onChange={e => setCustomModal(prev => ({ ...prev, values: { ...prev.values, [field.name]: e.target.value } }))} className={`w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-black/30 py-3 pr-3 text-sm text-gray-900 dark:text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60 ${field.icon ? 'pl-9' : 'pl-3'}`} /></div>}</div>)}</div>}
                            <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={isSavingCustomModal} onClick={closeCustomModal} className="rounded-xl border border-gray-200 dark:border-zinc-700 px-4 py-2.5 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50">Cancel</button><button type="button" disabled={isSavingCustomModal} onClick={submitCustomModal} className={`min-w-[132px] rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${customModal.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-primary/90'}`}>{isSavingCustomModal ? <><i className="fas fa-circle-notch fa-spin mr-2"></i>{customModal.danger ? 'Deleting...' : 'Updating...'}</> : <>{customModal.danger && <i className="fas fa-trash-alt mr-2"></i>}{customModal.confirmLabel}</>}</button></div>
                        </div>
                    </div>
                </div>
            )}

            {alertConfig.isOpen && (
                <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 fade-in p-4">
                    <div className="bg-white dark:bg-amoled-card p-5 sm:p-6 rounded-lg w-full max-w-sm text-center border dark:border-zinc-800 shadow-xl">
                        <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 dark:bg-red-900/30 mb-4"><i className="fas fa-exclamation-triangle text-red-600"></i></div>
                        <h3 className="text-lg font-bold mb-2 dark:text-white">{alertConfig.title}</h3>
                        <p className="text-gray-500 mb-6 text-sm">{alertConfig.message}</p>
                        <div className="flex justify-center gap-2">
                            <button onClick={() => setAlertConfig(prev => ({...prev, isOpen: false}))} className="px-4 py-2 border rounded dark:border-zinc-700 dark:text-gray-300 text-sm">Cancel</button>
                            {alertConfig.onConfirm && <button onClick={alertConfig.onConfirm} className="px-4 py-2 bg-red-600 text-white rounded text-sm">Confirm</button>}
                        </div>
                    </div>
                </div>
            )}
            
            {renderPayModal()}
            <AddCafeModal />
            <DeleteCafeModal />
            <ScheduleEditorModal />
            </div>
        </div>
    );
}

//Bubble Try First 